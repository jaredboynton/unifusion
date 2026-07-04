# unifusion

**Run a Fable orchestrator that dispatches frontier panelists in parallel, then synthesizes one
evidence-backed recommendation.**

Unifusion is an **OpenCode orchestrator harness** in the unifable family. `scripts/unifusion.sh` starts
one `opencode serve` daemon, runs a single `unifusion-orchestrator` thread (Fable on Bedrock global), and
captures the synthesized `[FINAL]` / `[ANALYSIS]` plus panelist reports from `task` tool events.

## Active flow

| Stage | Artifact | Role |
|---|---|---|
| Resolve brief | `resolve_session.sh` -> `summarize_session.sh` | factual-only session context |
| Build prompt | `scripts/unifusion.sh` | orchestrator prompt with context + verbatim task |
| Serve | `opencode serve` (skill-local `opencode/opencode.json`) | one warm headless daemon |
| Orchestrate | `unifusion-orchestrator` attach thread | strategy, parallel `task` dispatch, synthesis |
| Panelists | `panelist-*` subagents via `task` | tailored frontier-research reports |
| Save | `save_run.sh` | provenance under `~/.unifable/unifusion-runs/` |

## Active agents

| Agent | Backing model | Role |
|---|---|---|
| `unifusion-orchestrator` | Fable 5 (`amazon-bedrock/global.anthropic.claude-fable-5`) | strategy, dispatch, synthesis |
| `panelist-gpt` | GPT-5.5 (`openai-ws/gpt-5.5`) | frontier research |
| `panelist-grok` | Grok 4.3 (`amazon-bedrock/xai.grok-4.3`) | frontier research |
| `panelist-glm` | GLM-5.2 (`zai-coding-plan/glm-5.2`) | frontier research |
| `panelist-kimi` | Kimi K2.7 (`kimi-for-coding/k2p7`) | frontier research |

## Entry point

```bash
bash scripts/unifusion.sh /tmp/unifusion_question.txt
```

The script prints `RUN_DIR`, `ORCH_PROMPT`, `ANALYSIS`, `FINAL`, `DELIVERABLE`, `PROVENANCE`, and one
`PANELIST` line per slug.

## Notes

- Orchestrator dispatches all panelists in **one turn** for parallel `task` execution.
- Panelists receive **tailored assignments** from the orchestrator (not identical verbatim prompts).
- Session brief is factual only; user task is verbatim in the orchestrator prompt.
- `UNIFUSION_ORCH_TIMEOUT` defaults to 1500s (no per-panelist shell timeout).
- Archived: `scripts/archive/unifusion_droid.sh`, `scripts/archive/unifusion_parallel_cli.sh`.
