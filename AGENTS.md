# unifusion — agent notes

Maintainer notes for the **unifusion** skill itself. Runtime instructions live in `SKILL.md`.

## What it is

Unifusion is an **OpenCode serve + orchestrator attach** flow.

- The caller writes the user's question to a temp file.
- `scripts/unifusion.sh` builds a factual-only shared context brief when possible.
- That script starts **one** `opencode serve` daemon with the skill-local config
  (`opencode/opencode.json`), merged over the user's global OpenCode config (providers, auth, Exa MCP).
- It runs **one** `unifusion-orchestrator` attach thread (Fable on Bedrock global). The orchestrator:
  1. Devises a complementary research strategy.
  2. Dispatches four panelist subagents in parallel via the `task` tool (one turn, all four calls).
  3. Synthesizes their reports into `[FINAL]` / `[ANALYSIS]` and writes a deliverable under cwd.
- The shell parses the orchestrator stream, extracts panelist reports from `task` tool events, and persists
  provenance.

### Panelists (subagents)

- `panelist-gpt` — GPT-5.5 (`openai-ws/gpt-5.5`)
- `panelist-grok` — Grok 4.3 on Bedrock Mantle (`amazon-bedrock/xai.grok-4.3`)
- `panelist-glm` — GLM-5.2 (`zai-coding-plan/glm-5.2`)
- `panelist-kimi` — Kimi K2.7 (`kimi-for-coding/k2p7`)

### Orchestrator

- `unifusion-orchestrator` — Fable 5 (`amazon-bedrock/global.anthropic.claude-fable-5`), `mode: primary`

Gemini is not part of the active panel.

## Active files

- `scripts/unifusion.sh` — active entrypoint (serve + orchestrator attach + cleanup)
- `opencode/opencode.json` — skill-local config: orchestrator + four panelist subagents + provider overrides
- `opencode/orchestrator_prompt.md` — strategy, parallel dispatch, synthesis, deliverable write
- `opencode/architect_prompt.md` — shared panelist prompt (answer the assigned angle; report as final message)
- `opencode/parse_events.py` — final text, errors, and `task` tool results from NDJSON streams
- `scripts/resolve_session.sh` — host-agnostic transcript resolver
- `scripts/summarize_session.sh` — best-effort factual session brief
- `scripts/compact-full-transcript.mjs` — transcript compaction / summarization engine
- `scripts/save_run.sh` — provenance writer

## Archived paths

- `scripts/archive/unifusion_droid.sh` — Droid-native entrypoint
- `scripts/archive/unifusion_parallel_cli.sh` — pre-Droid multi-CLI fan-out
- `opencode/synth_prompt.md` — legacy separate-synth prompt (inactive)

Legacy per-CLI runner scripts remain in `scripts/` for reference and are **not** on the active path.

## Hard-won OpenCode facts (do not relearn these the slow way)

- `opencode run` **hangs at `init`** unless stdin is redirected. The script pipes the prompt on stdin.
- `OPENCODE_CONFIG` **merges** with global config; auth and Exa MCP are inherited.
- `opencode run --attach <url>` requires a **pre-created session** via `POST /session`.
- `--format json` output is **NDJSON**; assistant prose is in `type=="text"` events.
- Headless attach runs **auto-reject** `external_directory` unless `--auto` is passed. The orchestrator and
  panelists run with `--auto`.
- **Task parallelism**: multiple `task` calls in **one** orchestrator turn run concurrently (`Promise.all`).
  Dispatching panelists across separate turns serializes them.
- **MCP sharing**: under one `opencode serve`, Exa MCP is one client per server name shared by all
  sessions/subagents — concurrent Exa calls still contend on that connection.
- Panelists deny `skill` and `task` so they cannot recurse or load the unifusion skill.
- GPT-5.5 routes through **Codex OAuth** (`https://chatgpt.com/backend-api/codex/responses`), not
  `api.openai.com/v1`.
- Grok routes through **Bedrock Mantle** via `amazon-bedrock/xai.grok-4.3`.
- GLM must use **chat-completions** at `https://api.z.ai/api/coding/paas/v4`, not the Anthropic path.
- `parse_events.py --tasks` extracts orchestrator `task` tool results for panelist observability.
- Provenance stays shell-owned (`~/.unifable/unifusion-runs/`); orchestrator writes deliverable under cwd only.
- `opencode serve` spawns `opencode acp` worker children; cleanup snapshots pre-existing PIDs.

## Constraints

- Keep the shared context **factual only**. No proposed approach belongs in the brief.
- Keep the user's task **verbatim** in the orchestrator prompt.
- Keep the active panel defined through OpenCode agents in `opencode/opencode.json`.
- Prefer Exa-backed and primary-source research paths in the panelist prompt.
- Do not store secrets in the skill config or prompts.

## Testing

- `bash -n scripts/*.sh`
- `node --check scripts/compact-full-transcript.mjs`
- `uvx ruff check opencode/parse_events.py`
- `bash scripts/selfcheck.sh`

`bash scripts/unifusion.sh /tmp/q.md /tmp/ufrun` is the real smoke test (paid model calls). Run
**synchronously** — do not detach across a tool-call boundary.

## Safe-change rules

- `SKILL.md` and this file describe only **current** active behavior.
- Archive superseded entrypoints under `scripts/archive/`.
- Do not widen provenance writes beyond `${UNIFABLE_DATA:-~/.unifable}/unifusion-runs/`.
