---
name: unifusion
description: >-
  Answer a hard question by fanning it out to a PANEL of models running in parallel — each answering
  independently with web search and bash, none seeing the others' work, each citing real evidence
  (file:line, command output, source URLs) and verifying current versions and docs — then Opus 4.8 judges
  every response into a structured analysis (consensus, contradictions, partial coverage, unique insights,
  blind spots) and writes a final answer grounded in it. One script does it all: it auto-detects every
  model CLI installed and fans the panel out automatically — Opus 4.8 (via the `cb` Bedrock CLI), plus
  GPT-5.5 (codex), Gemini 3.5 Flash (agy), Kimi K2.7 (kimi), and GLM-5.2 (devin) when present, falling back
  to two independent Opus 4.8 runs when no external CLI exists. Each panelist runs clean-room (no plugins,
  hooks, or MCP) so the harness never contaminates the panel. Saves a timestamped provenance .md per run.
  Use whenever the user asks to "run it through Unifusion", says /unifusion, or wants a multi-model / panel
  / ensemble / cross-checked / higher-confidence answer with consensus and blind spots surfaced — even if
  they don't say "unifusion". Best for high-stakes research, design calls, and debugging where being
  confidently wrong is expensive.
---

# Unifusion

Unifusion turns one prompt into a panel. The question goes to several models **at the same time**, each
answering independently — with web search and bash, and with no knowledge of the others. Then Opus 4.8
(this very session — the orchestrator) reads every answer, extracts the structure of the panel's reasoning
(what they agree on, where they conflict, what only one saw, what they all missed), and writes a final
answer grounded in that analysis.

Every panelist gets the user's task **verbatim** — **no assigned "lenses" or personas** — and answers it
cold. (See `references/panel.md`.)

**Opus 4.8 always judges and writes the final answer.** Opus also runs as a panelist (via the `cb` CLI), but
those are separate clean Bedrock processes; the orchestrator session that judges is never one of them, so
the pipeline can't be reversed.

The whole panel is run by **one script** — `scripts/unifusion.sh`. It auto-detects which model CLIs are
installed, builds a best-effort session-context brief, assembles the single shared prompt, and fans every
available panelist out in parallel, blind, and clean-room. You (the orchestrator) only do two things after
it returns: **judge** the answers and **save** the provenance.

Throughout, `<skill_dir>` is the directory containing this SKILL.md (when installed:
`~/.claude/skills/unifusion`).

## Step 1 — Write the question, verbatim

Write the user's question **exactly as asked** to a file. Do not summarize, rephrase, or pre-digest it —
the panel's independence depends on every panelist getting the raw task.

```bash
cat > /tmp/unifusion_question.txt <<'EOF'
<the user's question, verbatim>
EOF
```

## Step 2 — Run the panel (one command)

```bash
bash <skill_dir>/scripts/unifusion.sh /tmp/unifusion_question.txt
```

That single call does everything that used to be separate steps:

- **Detects** the panel: Opus (always, via `cb`) plus every external CLI present — GPT-5.5 (`codex`),
  Gemini 3.5 Flash (`agy`), Kimi K2.7 (`kimi`), GLM-5.2 (`devin`). With no external CLI it runs **two**
  independent Opus runs (the `opus4.8-4.8` fallback).
- **Builds** a best-effort factual session-context brief and prepends the *identical* brief to every
  panelist prompt (skipped silently if it can't be built). This is the panel's one shared prior.
- **Assembles** the canonical prompt (`[SESSION CONTEXT]?` + uniform `[INSTRUCTIONS]` + verbatim `[TASK]`)
  once, and gives the same prompt to every panelist.
- **Fans out** all panelists in parallel and blind, each **clean-room** (every panelist runs with its
  plugins/hooks/MCP stripped — `cb --safe-mode`, an isolated `CODEX_HOME`, a minimal devin config, an empty
  kimi skills dir — so the unifable harness or a slow MCP server can never stall or correlate the panel),
  each against a throwaway copy of the repo so its file writes never touch your checkout.
- **Waits** for all, then prints a manifest. It never gates and never aborts: a missing or failing CLI
  drops only its own panelist (`opus4.8-4.8` is the ultimate fallback). Per-panelist timeout is
  `UNIFUSION_TIMEOUT` (default 300s); raise it for heavy deep-research questions.

Read the manifest it prints. The lines you act on:

```
RUN_DIR=/tmp/unifusion-panel.XXXXXX        # everything for this run lives here
PANEL_PROMPT=/.../panel_prompt.md          # the exact prompt every panelist got
SLUG=opus4.8-gpt5.5-gemini3.5flash-kimi2.7-glm5.2
PANELIST opus-A ok /.../cb_out.md
PANELIST gpt5.5 ok /.../codex_out.md
PANELIST gemini3.5flash dropped:timeout /.../gemini_out.md
...
```

Read every panelist file marked **`ok`** (e.g. `cb_out.md`, `codex_out.md`, ...). Treat any panelist marked
`dropped:*` as **absent** — never as silent agreement. Note the degradation for Step 4.

## Step 3 — Judge (pick the track that fits the task)

Read `references/judge_rubric.md` and **classify the deliverable first**, because code and prose merge
completely differently:

- **Artifact task** (code, script, config, schema — the user wants a buildable thing) → **Track A: run
  both, then merge**. You are integrating *implementations* into one working program, not writing a report.
  **Run each candidate with bash first** to see what actually works, graft the parts that worked onto the
  stronger base, then **run the merged result and fix until it passes**. (If it truly can't be executed
  here, fall back to seam-reasoning and mark it unverified.)
- **Research / analysis task** (the user wants understanding or a recommendation) → **Track B: structured
  synthesis** — the five sections: **Consensus**, **Contradictions**, **Partial coverage**, **Unique
  insights**, **Blind spots**. Don't average or smooth over conflict; independent agreement is your
  highest-confidence signal, honest disagreement is the most useful thing the panel produces. Write this
  analysis to `$RUN_DIR/analysis.md` for the provenance record.

Either way: attribute decisions to each panelist (by model / run), and weight a panelist that actually ran
the code or read a primary source over one reasoning from memory. If a session-context brief was injected
(the manifest shows `CONTEXT=<path>` rather than `CONTEXT=none`), the panel shared that prior: weight
agreement that merely restates the brief as a shared input rather than independent convergence (see
`references/judge_rubric.md`).

Then write the final deliverable:

- **Track A (code/artifact):** emit the complete, merged artifact — every file, ready to run as-is. Follow
  with a tight merge rationale: what each candidate did when run, what you took from each, what you verified.
- **Track B (research):** write the answer grounded in the structured analysis — lead with high-confidence
  consensus, fold in unique insights, flag what stays uncertain. It must follow *from* the synthesis, not be
  one panelist's answer lightly edited. Write it to `$RUN_DIR/final.md` for the provenance record.

## Step 4 — Save provenance, then present

Save the run to an internal provenance file under `~/.claude/unifusion-runs/` (raw panelist answers + the
analysis + the final answer, timestamped, for auditing). Pass the `SLUG` from the manifest and the
`RUN_DIR` — the script auto-discovers every panelist's answer file from it:

```bash
UNIFUSION_PANEL_NOTE="<degradation note, or empty>" \
bash <skill_dir>/scripts/save_run.sh <SLUG> /tmp/unifusion_question.txt \
  "$RUN_DIR/analysis.md" "$RUN_DIR/final.md" "$RUN_DIR"
```

Then **present**: lead with the **final deliverable** — the merged working artifact (Track A) or the
grounded answer (Track B) — then the audit trail beneath it: for code, what each candidate did when run +
the merge rationale + what you verified; for research, the five-section analysis. Name the panel slug you
ran and which panelists participated. If the panel downgraded because a CLI was missing or failed, say so
and how to enable the fuller panel (install the missing CLI).

## Cost & latency note

A panel costs roughly N× a single answer in tokens and runs as slow as its slowest panelist. For quick or
low-stakes questions, answer directly instead.
