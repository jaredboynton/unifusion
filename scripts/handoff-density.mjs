// Handoff density gate for the compaction reask loop.
//
// The deterministic gate fails grok-4.3 / flash-lite because their handoffs are
// thin: too few evidence capsules (source spans), too few distinct cited lines,
// no promises. Strict provider schemas cannot force array density at decode time
// (Bedrock 400s on minItems>1; Gemini Flash-Lite ignores it), so density is
// enforced after parsing via a reject-and-reask loop -- the universal pattern in
// Instructor / Guardrails / oh-my-openagent. See docs/prompt-adaptation/design.md.
//
// This module is self-contained (no import from the large, concurrently-edited
// harness) so it can be unit-tested in isolation and wired in with one import.

const ANCHORED_ARRAYS = [
  "summary_blocks",
  "rules_and_invariants",
  "plans_and_task_state",
  "promises_made",
];

// Each anchored item that carries source_spans becomes one evidence capsule in
// handoff-state.json, so the capsule count the scorer reads equals the number of
// source_spans entries across the anchored arrays.
export function countEvidenceCapsules(summary) {
  let n = 0;
  for (const key of ANCHORED_ARRAYS) {
    const arr = Array.isArray(summary?.[key]) ? summary[key] : [];
    for (const item of arr) {
      const spans = Array.isArray(item?.source_spans) ? item.source_spans : [];
      n += spans.length;
    }
  }
  return n;
}

export function countCitedUniqueLines(summary) {
  const lines = new Set();
  for (const key of ANCHORED_ARRAYS) {
    const arr = Array.isArray(summary?.[key]) ? summary[key] : [];
    for (const item of arr) {
      const spans = Array.isArray(item?.source_spans) ? item.source_spans : [];
      for (const span of spans) {
        if (Number.isInteger(span?.start_line)) lines.add(span.start_line);
        if (Number.isInteger(span?.end_line)) lines.add(span.end_line);
      }
    }
  }
  return lines.size;
}

export function countPromises(summary) {
  return Array.isArray(summary?.promises_made) ? summary.promises_made.length : 0;
}

export const DEFAULT_DENSITY_THRESHOLDS = {
  minEvidenceCapsules: 30,
  minCitedLines: 25,
  minPromises: 0,
};

// Evaluate handoff density against thresholds. Returns a pass flag, the measured
// metrics, the list of shortfalls, and a single corrective-feedback string built
// in the Instructor/Guardrails style (specific counts + imperative instruction)
// that the reask loop appends to the next request.
export function evaluateHandoffDensity(summary, thresholds = DEFAULT_DENSITY_THRESHOLDS) {
  const t = { ...DEFAULT_DENSITY_THRESHOLDS, ...(thresholds || {}) };
  const metrics = {
    evidence_capsules: countEvidenceCapsules(summary),
    cited_unique_lines: countCitedUniqueLines(summary),
    promises: countPromises(summary),
  };
  const shortfalls = [];
  if (metrics.evidence_capsules < t.minEvidenceCapsules) {
    shortfalls.push(
      "evidence is thin: " +
        metrics.evidence_capsules +
        " source-span-bearing items, need at least " +
        t.minEvidenceCapsules +
        " (add more summary_blocks / rules / plans, each citing a distinct source_span)"
    );
  }
  if (metrics.cited_unique_lines < t.minCitedLines) {
    shortfalls.push(
      "coverage is narrow: " +
        metrics.cited_unique_lines +
        " distinct cited transcript lines, need at least " +
        t.minCitedLines +
        " (cite source_spans across more of the transcript, not just a few records)"
    );
  }
  if (metrics.promises < t.minPromises) {
    shortfalls.push(
      "promises_made has " +
        metrics.promises +
        " entries, need at least " +
        t.minPromises +
        " (capture every commitment the assistant made, with source_spans)"
    );
  }
  // density score: fraction of thresholds met, used to keep the best attempt.
  const ratios = [
    Math.min(1, metrics.evidence_capsules / Math.max(1, t.minEvidenceCapsules)),
    Math.min(1, metrics.cited_unique_lines / Math.max(1, t.minCitedLines)),
  ];
  const score = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return {
    pass: shortfalls.length === 0,
    metrics,
    shortfalls,
    score,
    feedback: shortfalls.length === 0 ? "" : buildReaskFeedback(shortfalls),
  };
}

export function buildReaskFeedback(shortfalls) {
  return [
    "Your previous handoff was structurally valid but INCOMPLETE. The continuation",
    "summary must be denser. Issues with the previous attempt:",
    ...shortfalls.map((s) => "- " + s),
    "",
    "Regenerate the COMPLETE handoff from the same transcript: keep everything you",
    "already captured and add the missing detail. Every summary_blocks, rule, plan,",
    "and promise item must cite one or more exact source_spans. Do not shorten.",
    "",
    "Shape target: 8-10 named summary_blocks split by domain (state, intent, artifacts, pending",
    "work, transport, endpoints, models, tooling); 2-4 source_spans per block across different",
    "line ranges; verbatim paths, protocol strings, RPC names, and version numbers in every block",
    "body; populate rules_and_invariants, plans_and_task_state, and promises_made with cited spans.",
  ].join("\n");
}

// Corrective feedback for required literals that did not survive into the
// rehydrated handoff. Each literal is an exact string that appears verbatim in
// the transcript and must be recoverable from the handoff; the model is told to
// cite the source_span where it appears (and quote it verbatim) rather than
// paraphrase. Returns "" when nothing is missing so it composes with density
// feedback via a filter(Boolean).join.
export function buildLiteralReaskFeedback(missingLiterals) {
  if (!missingLiterals || missingLiterals.length === 0) return "";
  return [
    "REQUIRED LITERALS MISSING. The following exact strings appear in the transcript and MUST",
    "survive verbatim into your handoff. For each one, cite a source_span on the transcript",
    "record(s) where it appears AND quote it verbatim in the relevant summary_block body. Do not",
    "paraphrase, truncate, or normalize them (keep full paths, casing, and punctuation):",
    ...missingLiterals.map((literal) => "  - " + literal),
  ].join("\n");
}

// Corrective feedback when the previous attempt did not parse as JSON. The dominant
// cause is a provider truncating the output mid-string (e.g. Gemini finishReason
// MAX_TOKENS when thinking consumes the output budget), so the fix is to steer the
// retry toward a SHORTER, complete object rather than a longer one.
export function buildTruncationReaskFeedback(errorMessage) {
  return [
    "YOUR PREVIOUS RESPONSE WAS CUT OFF before the JSON finished" +
      (errorMessage ? " (" + errorMessage + ")" : "") +
      ". The output exceeded the token budget, so the object was truncated and unusable.",
    "Produce the SAME structure but more compactly so it completes: keep every block body to ONE",
    "short sentence, do not repeat content across blocks, and spend your budget on many concise",
    "source_spans rather than long prose. A complete, terse object beats a long, truncated one.",
  ].join("\n");
}
