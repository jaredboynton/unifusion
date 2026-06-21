---
name: unifusion
description: >-
  Answer a hard question by fanning it out to a PANEL of models running in parallel — each answering
  independently with web search and bash, none seeing the others' work, each citing real evidence
  (file:line, command output, source URLs) and verifying current versions and docs — then Opus 4.8 judges
  every response into a structured analysis (consensus, contradictions, partial coverage, unique insights,
  blind spots) and writes a final answer grounded in it. The panel scales to whatever model CLIs are
  installed: two independent Opus 4.8 runs (opus4.8-4.8), plus GPT-5.5 via codex, Gemini 3.1 Pro via agy,
  Kimi K2.7 via kimi, and GLM-5.2 via devin, up to opus4.8-gpt5.5-gemini3.1pro-kimi2.7-glm5.2. Saves a
  timestamped provenance .md per run. Use whenever the user asks to "run it through Unifusion", says /unifusion,
  or wants a multi-model / panel / ensemble / cross-checked / higher-confidence answer with consensus and
  blind spots surfaced — even if they don't say "unifusion". Best for high-stakes research, design calls, and
  debugging where being confidently wrong is expensive.
---

# Unifusion

Unifusion turns one prompt into a panel. The question goes to several models **at the same time**, each
answering independently — with web search and bash, and with no knowledge of the others. Then Opus 4.8
(this very session — the orchestrator) reads every answer, extracts the structure of the panel's reasoning
(what they agree on, where they conflict, what only one saw, what they all missed), and writes a final
answer grounded in that analysis.

Every panelist gets the user's task **verbatim** — **no assigned "lenses" or personas** — and answers it
cold. (See `references/panel.md`.)

**Opus 4.8 always judges and writes the final answer.** The slug reads driver-first (`opus4.8`) for that
reason.

Throughout, `<skill_dir>` is the directory containing this SKILL.md (when installed:
`~/.claude/skills/unifusion`). Write the user's question **verbatim** to `/tmp/unifusion_question.txt` first —
several steps reuse it.

## Step 0 — Pick the panel

```bash
bash <skill_dir>/scripts/detect_panel.sh
```

It prints a `SLUG=` line recommending the richest panel possible on this machine. The slug reads
driver-first (`opus4.8`) and appends one token per available external CLI:

| Token | Panelist | Requires |
| --- | --- | --- |
| `-gpt5.5` | GPT-5.5 | `codex` CLI |
| `-gemini3.1pro` | Gemini 3.1 Pro | `agy` CLI |
| `-kimi2.7` | Kimi K2.7 | `kimi` CLI |
| `-glm5.2` | GLM-5.2 | `devin` CLI |

So the full panel is `opus4.8-gpt5.5-gemini3.1pro-kimi2.7-glm5.2` (all four CLIs present); with fewer CLIs
the detector emits the richest subset, and with none it falls back to `opus4.8-4.8` (the same prompt run
twice as two independent Opus 4.8 panelists, always available).

If the user named a slug (or used a pinned `/unifusion-*` command, e.g. `/unifusion-5` for the full panel),
honor it — but if a required CLI is missing, say so, drop that panelist, and fall back to the next-richest
panel rather than failing. Otherwise use the detector's recommendation.

## Step 1 — Preflight (informational, never a gate)

```bash
bash <skill_dir>/scripts/preflight.sh <SLUG> /tmp/unifusion_question.txt
```

Show its output to the user (rough token/call estimate + Codex cap reminder), then proceed. It never
blocks. Each panelist is bounded by a per-panelist timeout (`UNIFUSION_TIMEOUT`, default 300s) baked into the
runners; raise it for heavy deep-research questions (`UNIFUSION_TIMEOUT=600 bash <skill_dir>/scripts/...`).

## Step 1.5 — Inject session context (best-effort)

When Unifusion runs inside a session, build a compact factual brief of it and prepend that brief to every
panelist's prompt so the whole panel shares the same context:

```bash
bash <skill_dir>/scripts/summarize_session.sh /tmp/unifusion_context.md
```

`resolve_session.sh` locates the current session transcript host-agnostically — by walking process
ancestry to the host agent (Claude Code / Codex / Droid / Devin), reading its session id, and
disambiguating with the verbatim question as a fingerprint; an unresolvable session simply skips
injection. `compact-full-transcript.mjs` then summarizes that transcript with schema-constrained
structured output (gemini-3.5-flash by default) into `/tmp/unifusion_context.md` — factual state only
(goals, decisions, constraints, files, current state, open questions), never an approach or the answer
(forward-looking sections are stripped before injection). It is **best-effort and never a gate**: exit 3 (no transcript),
4 (no API key), and 6 (summarizer failed) all mean "skip injection", so if it produces nothing, fan out on
the verbatim task alone. The identical brief goes to **every** panelist.

## Step 2 — Fan out, in parallel and blind

Read `references/panel.md` and assemble each panelist's prompt with the canonical structure documented
there: the optional `[SESSION CONTEXT]` brief from Step 1.5, then the uniform `[INSTRUCTIONS]` block
(research with web + bash; back every claim with cited evidence — file:line or command output for
code/system claims, source URLs for web claims; verify current versions and official docs), then the
user's task **verbatim** under `[TASK]`. Do **not** assign personas and do **not** pre-digest the task.
(Answer in the user's question language.)

Launch **all panelists in a single turn** so they run concurrently:

- **Opus 4.8 panelist(s)** → the `Agent` tool, `subagent_type: general-purpose` (web + bash built in).
  For `opus4.8-4.8`, spawn **two** independent Opus subagents with the *same* prompt — two cold runs.
  Spawn them in the same message so they run at once. When each returns, write its answer to a temp file
  for provenance: `/tmp/unifusion_opusA.md` (and `/tmp/unifusion_opusB.md` for the second Opus run).
- **GPT-5.5 panelist** (if slug includes it) → write its prompt to a temp file, then run:
  ```bash
  unifusion_run_dir="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-panel.XXXXXX")"
  bash <skill_dir>/scripts/run_codex.sh "$unifusion_run_dir/codex_prompt.md" "$unifusion_run_dir/codex_out.md" xhigh
  ```
  Allocate one unique `unifusion_run_dir` per Unifusion invocation and put every prompt/output file for that
  invocation under it. Never use fixed paths like `/tmp/unifusion_codex_prompt.txt` or
  `/tmp/unifusion_codex_out.md`; multiple Claude Code sessions can run Unifusion concurrently, and fixed names
  let one run read another run's prompt or answer.
  The runner copies the current repo/workdir to a throwaway directory, then launches `codex exec` against
  that copy with full local access. `-o` makes codex write only its final answer to the out file; read it
  once it finishes. Exit 124 = timed out (`UNIFUSION_TIMEOUT`); any other non-zero exit = drop GPT-5.5 and
  note the panel downgraded.
- **Gemini panelist** (if slug includes it) →
  ```bash
  bash <skill_dir>/scripts/run_gemini.sh "$unifusion_run_dir/gemini_prompt.md" "$unifusion_run_dir/gemini_out.md"
  ```
  This runs `agy` under a pseudo-TTY with a transcript-JSONL fallback. Exit 127 = `agy` not installed;
  exit 1 = empty answer; exit 124 = timed out. On any non-zero exit, drop Gemini and note the panel
  downgraded.
- **Kimi panelist** (if slug includes `kimi2.7`) →
  ```bash
  bash <skill_dir>/scripts/run_kimi.sh "$unifusion_run_dir/kimi_prompt.md" "$unifusion_run_dir/kimi_out.md"
  ```
  Runs Kimi K2.7 via `kimi -p ... --output-format text` against a throwaway copy of the repo/workdir, with
  native web search and bash. The runner strips Kimi's output wrapper (a leading bullet and a uniform
  2-space hanging indent) so the answer file is clean Markdown. Exit 127 = `kimi` not installed; exit 124 =
  timed out; any other non-zero or empty = drop Kimi and note the panel downgraded.
- **GLM-5.2 panelist** (if slug includes `glm5.2`) →
  ```bash
  bash <skill_dir>/scripts/run_devin.sh "$unifusion_run_dir/devin_prompt.md" "$unifusion_run_dir/devin_out.md"
  ```
  Runs GLM-5.2 via `devin --print --prompt-file ... --permission-mode dangerous` against a throwaway copy
  of the repo/workdir, with native web search and bash (the model is inherited from the devin config;
  override with `DEVIN_MODEL`). Exit 127 = `devin` not installed; exit 124 = timed out; any other non-zero
  or empty = drop GLM-5.2 and note the panel downgraded.

Keep panelists isolated: never paste one panelist's output into another's prompt. The orchestrator (you) is
the judge and must stay separate from the panelists — for `opus4.8-4.8`, both panelists are spawned
subagents, not you, so your synthesis reads all answers fresh.

**Graceful degradation.** If an external panelist exits non-zero, drop it, record a one-line note (e.g.
`kimi dropped: timeout -> opus4.8-gpt5.5-gemini3.1pro-glm5.2`), and continue with what's left. The ultimate
fallback is `opus4.8-4.8`. Never abort because one CLI failed.

## Step 3 — Judge (pick the track that fits the task)

Once every panelist has returned, read `references/judge_rubric.md` and **classify the deliverable first**,
because code and prose merge completely differently:

- **Artifact task** (code, script, config, Minecraft mod/datapack, schema — the user wants a buildable
  thing) → **Track A: run both, then merge**. You are integrating two *implementations* into one working
  program, not writing a report. **Run each candidate with bash first** to see what actually works and what
  breaks in each, decide what to keep based on observed behavior (not on which looks better), graft the
  parts that worked onto the stronger base, then **run the merged result and fix until it passes**. (If it
  truly can't be executed here — needs the live game or an unavailable toolchain — fall back to
  seam-reasoning and mark it unverified.)
- **Research / analysis task** (the user wants understanding or a recommendation) → **Track B: structured
  synthesis** — the five sections: **Consensus**, **Contradictions**, **Partial coverage**, **Unique
  insights**, **Blind spots**. Don't average or smooth over conflict; independent agreement is your
  highest-confidence signal, honest disagreement is the most useful thing the panel produces. Write this
  analysis to `/tmp/unifusion_analysis.md` for the provenance record.

Either way: attribute decisions to each panelist (by model / run), and weight a panelist that actually ran
the code or read a primary source over one reasoning from memory. If a panelist failed or was dropped, the
judge treats it as **absent** — never as silent agreement. If a session-context brief was injected in Step
1.5, remember the panel shared that prior: weight agreement that merely restates the brief as a shared
input rather than independent convergence (see `references/judge_rubric.md`).

## Step 4 — Final deliverable

- **Track A (code/artifact):** emit the complete, merged artifact — every file, ready to run as-is (not a
  diff or "take A's X and B's Y"). Follow with a tight merge rationale: what each candidate did when run,
  what you took from each, and what you verified.
- **Track B (research):** write the answer grounded in the structured analysis — lead with high-confidence
  consensus, fold in unique insights, flag what stays uncertain. It must follow *from* the synthesis, not
  be one panelist's answer lightly edited. Write it to `/tmp/unifusion_final.md` for the provenance record.

## Step 5 — Save provenance

Save the run to an internal provenance file under `~/.claude/unifusion-runs/` (raw panelist answers + the
analysis + the final answer, timestamped, for auditing):

```bash
UNIFUSION_PANEL_NOTE="<degradation note, or empty>" \
UNIFUSION_ESTIMATE="<the preflight one-liner, optional>" \
UNIFUSION_CONTEXT_FILE="/tmp/unifusion_context.md" \
bash <skill_dir>/scripts/save_run.sh <SLUG> /tmp/unifusion_question.txt /tmp/unifusion_analysis.md /tmp/unifusion_final.md \
  "opus-A=/tmp/unifusion_opusA.md" "gpt5.5=$unifusion_run_dir/codex_out.md" "gemini=$unifusion_run_dir/gemini_out.md" \
  "kimi2.7=$unifusion_run_dir/kimi_out.md" "glm5.2=$unifusion_run_dir/devin_out.md"
```

(`save_run.sh` substitutes a placeholder for any answer file that is missing or empty, so a degraded panel
still produces a complete record.)

## Step 6 — Present

Lead with the **final deliverable** — the merged working artifact (Track A) or the grounded answer
(Track B) — then the audit trail beneath it: for code, what each candidate did when run + the
merge rationale + what you verified; for research, the five-section analysis. Name the panel slug you ran and which panelists participated. If the
panel downgraded because a CLI was missing, say so and how to enable the fuller panel (install the missing
CLI).

## Cost & latency note

A panel costs roughly N× a single answer in tokens and runs as slow as its slowest panelist. For quick or
low-stakes questions, answer directly instead.
