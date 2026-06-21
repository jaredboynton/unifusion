# unifusion — agent notes

Maintainer notes for editing the **unifusion** skill itself. The runtime contract the calling model
follows lives in `SKILL.md`; the panel/judge policy lives in `references/`. This file is for an agent
changing the scripts or the skill's structure. Do not duplicate `SKILL.md` here.

## What it is

Fanned-out multi-model panel + synthesis. The orchestrator (Opus 4.8, Claude Code) writes the user's
question to a temp file, then runs ONE script — `scripts/unifusion.sh` — which auto-detects every panelist
CLI and fans the SAME prompt to all of them **in parallel, blind, and clean-room** (Opus via the `cb`
Bedrock CLI; external models via `scripts/run_*.sh`). Opus then judges every answer and writes the final
deliverable. Opus is always the judge and is never one of the panelist processes, so the pipeline can't be
reversed. Claude Code is the only runtime (no Codex/Cursor variant here).

The single-entrypoint design is deliberate: detection, the session brief, prompt assembly, and the per-CLI
fan-out used to be separate manual steps with slugs/pins to choose; now `unifusion.sh` does all of it and
the caller only judges + saves. "Always use all available," automatically.

## Architecture

Plain bash + two interpreter helpers; no build step.

- `scripts/unifusion.sh <question_file> [run_dir]` — THE entrypoint. Detects panelist CLIs (cb/codex/agy/
  kimi/devin), builds the best-effort session brief, assembles the one canonical prompt
  (`panel_prompt.md`), fans every available panelist out as parallel background jobs into
  `<run_dir>/<label>_out.md` (always Opus via `cb`; a 2nd `cb` if no external CLI → the `opus4.8-4.8`
  fallback), waits, and prints a manifest (`RUN_DIR=`, `PANEL_PROMPT=`, `CONTEXT=`, `SLUG=`, one
  `PANELIST <label> <ok|dropped:reason> <out>` line each, `ESTIMATE=`). Never judges, never gates, always
  exits 0. Folds in the old `detect_panel.sh` + `preflight.sh` (both removed).
- `scripts/run_cb.sh` — Opus 4.8 panelist via `cb -p --model opus --safe-mode --output-format text` (stdin
  prompt). `--safe-mode` strips plugins/MCP/hooks/skills so the nested Claude runs clean; the `cb` wrapper
  auto-adds `--dangerously-skip-permissions` for web+bash. Override model via `UNIFUSION_OPUS_MODEL`.
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
- `scripts/run_codex.sh` (GPT-5.5), `run_gemini.sh` (Gemini 3.5 Flash via `agy`), `run_kimi.sh` (Kimi K2.7),
  `run_devin.sh` (GLM-5.2) — one external panelist each.
- `scripts/_unifusion_lib.sh` — sourced by the runners; `have()` and `_run_with_timeout` (perl fork+alarm,
  since stock macOS has no `timeout`/`gtimeout`). The child is exec'd as its own **process-group leader** and
  the deadline/signal handler kills the whole group, so panelist helper children (codex MCP servers, kimi's
  `kimi-code` worker) are reaped instead of orphaned. `UNIFUSION_TIMEOUT` default 300s.
- `scripts/_pty_run.py` — runs `agy` under a fresh pty (`pty.fork`) to dodge agy bug #76 (empty stdout
  with no TTY) while surviving a socket stdin (headless/cmux).
- `scripts/save_run.sh` — writes the provenance `.md` under `~/.claude/unifusion-runs/` only. Accepts a
  single `<run_dir>` 5th arg and auto-discovers `*_out.md` (mapping cb_out→opus-A, cb_out_b→opus-B,
  codex_out→gpt5.5, gemini_out→gemini3.5flash, kimi_out→kimi2.7, devin_out→glm5.2), or an explicit
  `LABEL=path` list as fallback.
- `references/panel.md`, `references/judge_rubric.md` — panel composition + the two judge tracks.

## Clean room (why panelists don't load the harness)

The unifable/fablize harness is installed into every CLI's user config (Claude plugins; codex `hookd@hookd`
hooks + `[mcp_servers]` + turn-end notify; devin `hooks` running `gate_prompt.py`/`gate_post_tool.py`; kimi
auto-discovered skills). Left in place it stalls or correlates a panelist — most visibly the groundedness
breaker, which blocks a panelist's mutation tools in a loop until it times out, and codex MCP startup, which
hangs / "nests" into a shared app-server across concurrent runs. So every runner strips it, the analogue of
`cb --safe-mode`:

- **cb** → `--safe-mode` (no plugins/MCP/hooks/skills/memory).
- **codex** → isolated `CODEX_HOME` (throwaway dir: minimal `config.toml` + copied `auth.json`; no
  mcp_servers, no hooks, no notify). Per-run, so concurrent runs never share Codex state.
- **devin** → `--config <throwaway minimal.json>` = real config minus `hooks`/`plugins`/`rules`/`skills`,
  model pinned to glm-5.2.
- **kimi** → `--skills-dir <empty>`; plus a best-effort by-name reap of the `kimi-code` worker it spawns
  (snapshot PIDs before, TERM/KILL the new ones after) since that worker daemonizes out of the process group.
- **agy** → left as-is (separate Antigravity binary; verified clean, has its own anti-empty guard).

`SKILL.md` is the entry; the skill is reachable identically at `~/.agents/skills/unifusion` and
`~/.claude/skills/unifusion` (same inode).

## Runner contract (every `run_*.sh`)

- Signature `run_<cli>.sh <prompt_file> <output_file> [extra]`; writes ONLY the model's clean final
  answer to `<output_file>`.
- cb/codex/kimi/devin run the model against a **throwaway copy** of the repo/workdir (deleted on exit), so a
  panelist's file writes never touch the live checkout.
- Run **clean-room**: strip the CLI's plugins/hooks/MCP/skills (see Clean room above) so the harness can't
  stall or correlate the panel.
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
| `UNIFUSION_OPUS_MODEL` | `opus` | cb model alias for the Opus panelist(s) |
| `UNIFUSION_CODEX_MODEL` | `gpt-5.5` | model in the isolated codex config |
| `KIMI_MODEL` | `kimi-k2.7-code-highspeed` | Kimi model id |
| `DEVIN_MODEL` | `glm-5.2` | model pinned in the throwaway devin config |
| `DEVIN_CONFIG` | `~/.config/devin/config.json` | source config the minimal one is derived from |
| `AGY_MODEL` | `Gemini 3.5 Flash (High)` | agy model name |
| `UNIFUSION_AGY_NO_MODEL` | (unset) | omit `--model`, use agy default |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | (unset) | enables the (gemini) session-context brief |
| `UNIFUSION_CONTEXT_PROVIDER` | `gemini` | summarizer provider (`codex`/`xai`/`mantle` also valid) |
| `UNIFUSION_TRANSCRIPT` | (unset) | explicit transcript path; overrides resolver/`--session` auto-detection |
| `UNIFUSION_CONTEXT_FILE`, `UNIFUSION_PANEL_NOTE`, `UNIFUSION_ESTIMATE` | — | passed into `save_run.sh` |

## Adding a panelist CLI

1. Write `scripts/run_<cli>.sh` to the runner contract above (copy the closest existing runner) — including
   the clean-room stripping for that CLI.
2. In `scripts/unifusion.sh`: add a `have <cli>` probe, and a `launch <label> <slug_token> <out>.md bash
   "$SCRIPT_DIR/run_<cli>.sh"` line in the fan-out block (bump `ext` if it's an external CLI).
3. Add the panelist to `references/panel.md` composition.
4. In `scripts/save_run.sh`, add a `<out_stem>` → label mapping in the auto-discover `label_for` case.
5. The estimate panelist count is derived from how many were launched; no edit needed.

## Testing

No harness besides `selfcheck.sh`. Smoke-test each script directly:

- `printf 'what is the latest node LTS?' > /tmp/q.md && bash scripts/run_<cli>.sh /tmp/q.md /tmp/o.md;
  echo "exit=$?"; cat /tmp/o.md` → clean Markdown, no wrapper artifacts. (For each of cb/codex/gemini/kimi/
  devin; confirm it returns in seconds, not blocked by hooks/MCP — that's the clean-room working.)
- `bash scripts/unifusion.sh /tmp/q.md /tmp/ufrun` → a manifest with one `PANELIST ... ok ...` per installed
  CLI; every `*_out.md` in `/tmp/ufrun` is non-empty and distinct. After, `ps aux | grep kimi-code | grep -v
  grep | wc -l` should not grow run-over-run (orphan reap).
- `bash -n scripts/*.sh` to syntax-check after edits.
- `bash scripts/summarize_session.sh /tmp/ctx.md; echo "exit=$?"; head /tmp/ctx.md` → exit 0, a factual
  brief. Failable checks: the engine's `result.json` `transcript_sha256` equals `shasum -a256` of the live
  session file, and `grep -E '^## (Plans And Task State|Promises Made)'` on the brief returns nothing
  (the factual-only filter held).
- `bash scripts/save_run.sh <slug> /tmp/q.md /tmp/an.md /tmp/fn.md /tmp/ufrun` → a record under
  `~/.claude/unifusion-runs/` with a `### <label>` section per panelist.
- `bash scripts/selfcheck.sh` → PASS.

## Safe-change rules

- Keep Opus as the sole judge; the orchestrator session must stay separate from the panel. Opus panelists
  run as separate `cb` processes and can't call back out to spawn the judge (see `references/panel.md`,
  `judge_rubric.md`).
- Keep every panelist clean-room (strip plugins/hooks/MCP/skills). The harness — especially the
  groundedness breaker — will otherwise block a panelist's tools in a loop until timeout, or correlate the
  panel; clean-room is what makes codex/devin/kimi reliable.
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
