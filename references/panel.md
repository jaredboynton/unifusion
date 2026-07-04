# The panel

Unifusion's power comes from **complementary research angles, synthesized**: one orchestrator decomposes
the question, assigns distinct facets to frontier models, and fuses their reports into one evidence-backed
answer. Agreement across models on the same finding is high confidence; disagreement is the signal worth
surfacing.

## Orchestrator-directed assignments

The **Fable orchestrator** (`unifusion-orchestrator`) owns the research strategy. It:

1. Reads the verbatim user request (plus any shared factual session context).
2. Decomposes the problem into **complementary angles** — not redundant rephrasings.
3. Dispatches every panelist subagent in **one turn** via the `task` tool (parallel execution).
4. Synthesizes the returned reports into `[FINAL]` and `[ANALYSIS]`.
5. Writes a deliverable file under the repo cwd when instructed.

This is a deliberate shift from the older "independent panel + separate judge" model. Panelists receive
**tailored assignments** from the orchestrator rather than identical verbatim prompts. The orchestrator
may steer *what each model investigates*; panelists still must ground claims in evidence gathered during
their run.

## Panel composition

Four frontier panelists, each a `mode: subagent` pinned to a distinct model:

| Subagent | Model | Slug token |
|----------|-------|------------|
| `panelist-gpt` | GPT-5.5 (Codex OAuth) | `gpt5.5` |
| `panelist-grok` | Grok 4.3 (Bedrock Mantle) | `grok4.3` |
| `panelist-glm` | GLM-5.2 | `glm5.2` |
| `panelist-kimi` | Kimi K2.7 | `kimi2.7` |

Gemini is not part of the active panel.

The orchestrator is **Claude Fable 5** on Bedrock global inference
(`amazon-bedrock/global.anthropic.claude-fable-5`). It is the sole primary agent; panelists are invoked only
via `task`.

## Shared session context (factual only)

When Unifusion runs inside a working session, `unifusion.sh` prepends a single **session-context brief**
to the orchestrator prompt (built best-effort by `summarize_session.sh`). It is bounded on purpose:

- **Factual state only** — goals, decisions, constraints, files, current state, open questions.
- Never an approach or hint at the answer.
- Best-effort: when unavailable, the orchestrator works from the verbatim task alone.

## What each panelist receives

Each panelist gets a **tailored assignment** from the orchestrator's `task` prompt, including:

- The original user request for context.
- The specific angle this panelist owns.
- The evidence standard (file paths with line numbers for local code; URLs for external sources).
- Instruction to return the full structured report as the final assistant message.

Panelists are read-only (no write/edit/bash/skill/task). Research uses read/grep/glob/list, Exa MCP, and
webfetch.

## Parallelism requirement

OpenCode runs concurrent `task` invocations from the **same assistant turn** in parallel. The orchestrator
prompt instructs Fable to emit all four `task` calls in one turn. If panelists are dispatched across
separate turns, they run sequentially and the run becomes much slower.

## Observability

The shell extracts panelist reports from orchestrator `task` tool events (`parse_events.py --tasks`) and
writes them under `reports/<slug>.md` for provenance. There is no per-panelist shell timeout; one hung
subagent blocks the orchestrator until `UNIFUSION_ORCH_TIMEOUT` (default 1500s).

## Synthesis

The orchestrator synthesizes inline — there is no separate synth thread. It returns `[FINAL]` and
`[ANALYSIS]` markers in its final message; the shell parses those into `final.md` and `analysis.md`.
