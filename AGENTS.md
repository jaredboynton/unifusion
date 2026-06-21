# unifusion — agent notes

Maintainer notes for editing the **unifusion** skill itself. The runtime contract the calling model
follows lives in `SKILL.md`; the panel/judge policy lives in `references/`. This file is for an agent
changing the scripts or the skill's structure. Do not duplicate `SKILL.md` here.

## What it is

Fanned-out multi-model panel + synthesis. The orchestrator (Opus 4.8, Claude Code) writes the user's
question to a temp file, picks a panel, fans the SAME prompt to several models **in parallel and blind**
(Opus subagents via the `Agent` tool; external models via `scripts/run_*.sh`), then Opus judges every
answer and writes the final deliverable. Opus is always the judge; the pipeline can't be reversed.
Claude Code is the only runtime (no Codex/Cursor variant here).

## Architecture

Plain bash + two interpreter helpers; no build step.

- `scripts/detect_panel.sh` — probes external CLIs, prints a `SLUG=` line (driver-first `opus4.8` +
  one token per available CLI; falls back to `opus4.8-4.8`).
- `scripts/preflight.sh <slug> <question_file>` — token/call estimate; informational, never gates.
- `scripts/resolve_session.sh [--path|--id|--json] [--fingerprint-file <f>]` — host-agnostic resolver:
  walks process ancestry to the host agent (claude/codex/droid/devin), reads its session id (env/argv/
  `devin list`), maps id→transcript path, and uses the fingerprint (the verbatim question) to disambiguate
  among cwd candidates and verify the pick. Unresolved → non-zero (fail closed).
- `scripts/summarize_session.sh <out>` → resolver → `scripts/compact-full-transcript.mjs` — best-effort
  factual session brief. The shim resolves the transcript via `resolve_session.sh --path --fingerprint-file
  /tmp/unifusion_question.txt`, runs the summarizer with `--transcript <path> --provider gemini`, then strips
  forward-looking sections so the shared brief stays factual-only. Exit 3 (no transcript) / 4 (no key) /
  6 (failed) → orchestrator skips injection.
- `scripts/compact-full-transcript.mjs` — multi-provider (codex/gemini/xai/mantle) transcript summarizer
  using **schema-constrained structured output** (`responseMimeType` + JSON schema, no function calling).
  Transcript source precedence: `--input` > `--transcript`/`UNIFUSION_TRANSCRIPT` > `--session` (Claude-only);
  no source → exit 3. A content guard exits 3 if the transcript yields no citable text before any API call.
  Two foreign-format adapters feed the native Claude pipeline: `codexPayloadText` makes Codex `.payload`-shaped
  records citable/renderable, and `atifToClaudeJsonl` converts a Devin ATIF-v1.4 JSON document (`steps[]`)
  into Claude-shaped JSONL records (`sha256`/`bytes` still hash the original file). So Claude, Codex, Droid,
  and Devin transcripts all summarize end-to-end. Writes a bundle to `--out-dir`; the brief is
  `<out-dir>/summary.md`. Vendored from claudecompact-patcher; keep the four provider dispatch paths in sync
  if edited.
- `scripts/run_codex.sh` (GPT-5.5), `run_gemini.sh` (Gemini 3.1 Pro via `agy`), `run_kimi.sh` (Kimi K2.7),
  `run_devin.sh` (GLM-5.2) — one external panelist each.
- `scripts/_unifusion_lib.sh` — sourced by the runners; `have()` and `_run_with_timeout` (perl fork+alarm,
  since stock macOS has no `timeout`/`gtimeout`). `UNIFUSION_TIMEOUT` default 300s.
- `scripts/_pty_run.py` — runs `agy` under a fresh pty (`pty.fork`) to dodge agy bug #76 (empty stdout
  with no TTY) while surviving a socket stdin (headless/cmux).
- `scripts/save_run.sh` — writes the provenance `.md` under `~/.claude/unifusion-runs/` only.
- `references/panel.md`, `references/judge_rubric.md` — panel composition + the two judge tracks.

`SKILL.md` is the entry; the skill is reachable identically at `~/.agents/skills/unifusion` and
`~/.claude/skills/unifusion` (same inode).

## Runner contract (every `run_*.sh`)

- Signature `run_<cli>.sh <prompt_file> <output_file> [extra]`; writes ONLY the model's clean final
  answer to `<output_file>`.
- codex/kimi/devin run the model against a **throwaway copy** of the repo/workdir (deleted on exit), so a
  panelist's file writes never touch the live checkout.
- Strip the CLI's wrapper to clean Markdown (ANSI + control bytes; kimi also has a leading bullet +
  2-space hanging indent).
- Exit codes are the degradation signal: `127` CLI missing, `124` timed out (`UNIFUSION_TIMEOUT`), `1`/other
  non-zero / empty → orchestrator drops that panelist. **Never exit 0 with an empty answer** (see
  run_gemini.sh's anti-empty guard).
- Match GPT-5.5's output style: enable web search, give full local tool access, request high reasoning.

## Env knobs

| Var | Default | Effect |
|-----|---------|--------|
| `UNIFUSION_TIMEOUT` | `300` | per-panelist deadline (seconds) |
| `KIMI_MODEL` | `kimi-code/kimi-for-coding` | Kimi model id |
| `DEVIN_MODEL` | (unset → devin config `glm-5-2`) | override GLM model |
| `AGY_MODEL` | `Gemini 3.1 Pro (High)` | agy model name |
| `UNIFUSION_AGY_NO_MODEL` | (unset) | omit `--model`, use agy default |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | (unset) | enables the (gemini) session-context brief |
| `UNIFUSION_CONTEXT_PROVIDER` | `gemini` | summarizer provider (`codex`/`xai`/`mantle` also valid) |
| `UNIFUSION_TRANSCRIPT` | (unset) | explicit transcript path; overrides resolver/`--session` auto-detection |
| `UNIFUSION_CONTEXT_FILE`, `UNIFUSION_PANEL_NOTE`, `UNIFUSION_ESTIMATE` | — | passed into `save_run.sh` |

## Adding a panelist CLI

1. Write `scripts/run_<cli>.sh` to the runner contract above (copy the closest existing runner).
2. Add a probe + slug token in `detect_panel.sh` and the availability print block.
3. Add the launch block in `SKILL.md` Step 2 and a row to `references/panel.md` composition.
4. Add its `label=path` to the `save_run.sh` call in `SKILL.md` Step 5.
5. The preflight panelist count is derived from the slug; no edit needed.

## Testing

No harness. Smoke-test each script directly:

- `bash scripts/detect_panel.sh` → expect a `SLUG=` line.
- `printf 'what is the latest node LTS?' > /tmp/q.md && bash scripts/run_<cli>.sh /tmp/q.md /tmp/o.md;
  echo "exit=$?"; cat /tmp/o.md` → clean Markdown, no wrapper artifacts.
- `bash -n scripts/*.sh` to syntax-check after edits.
- `bash scripts/summarize_session.sh /tmp/ctx.md; echo "exit=$?"; head /tmp/ctx.md` → exit 0, a factual
  brief. Failable checks: the engine's `result.json` `transcript_sha256` equals `shasum -a256` of the live
  session file, and `grep -E '^## (Plans And Task State|Promises Made)'` on the brief returns nothing
  (the factual-only filter held).
- An end-to-end run lands a timestamped record in `~/.claude/unifusion-runs/`.

## Safe-change rules

- Keep Opus as the sole judge; panelists can't spawn Opus, so the orchestrator must stay separate from
  the panel (see `references/panel.md`, `judge_rubric.md`).
- Never paste one panelist's output into another's prompt — independence is the mechanism.
- Keep the factual-only post-filter in `summarize_session.sh` (strips Plans / Promises / Next-Step). The
  session brief is the panel's one shared prior; leaking proposed next steps would correlate the panel.
- Keep `compact-full-transcript.mjs` on schema-constrained structured output (never function calling);
  preserve all four provider dispatch paths when editing it.
- Transcript resolution must be a deterministic id or a unique fingerprint match, else exit non-zero;
  never select a transcript by mtime/birth-time/cwd — a wrong transcript would corrupt every panelist.
- Keep the `_run_with_timeout` / pty helpers; they work around real macOS / headless limitations.
- A failing CLI drops only its own token; never abort the whole run.
- Provenance writes stay under `~/.claude/unifusion-runs/` (internal disk); never widen that path.
- This is a skill dir — keep runtime guidance in `SKILL.md`/`references/`, maintainer notes here only.
