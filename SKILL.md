---
name: unifusion
description: >-
  Answer a hard technical question by running a Fable orchestrator on OpenCode that devises a research
  strategy, dispatches GPT-5.5, Grok 4.3, GLM-5.2, and Kimi K2.7 as parallel panelist subagents, and
  synthesizes their findings into one evidence-backed final answer. Writes analysis/final artifacts plus
  provenance. Use whenever the user asks to "run it through Unifusion", wants a multi-model panel answer,
  or wants the best current approach grounded in code evidence, official docs, flagship GitHub repos,
  benchmarks, or research papers.
---

# Unifusion

Unifusion runs a **Fable orchestrator** on OpenCode. One `opencode serve` daemon starts with a skill-local
config; a single `unifusion-orchestrator` thread devises complementary research angles, dispatches four
frontier panelists in parallel via the `task` tool, synthesizes their reports, and returns the answer.

### Panelists (subagents)

- `panelist-gpt` — GPT-5.5 (`openai-ws/gpt-5.5`)
- `panelist-grok` — Grok 4.3 on Bedrock Mantle (`amazon-bedrock/xai.grok-4.3`)
- `panelist-glm` — GLM-5.2 (`zai-coding-plan/glm-5.2`)
- `panelist-kimi` — Kimi K2.7 (`kimi-for-coding/k2p7`)

### Orchestrator

- `unifusion-orchestrator` — Fable 5 (`amazon-bedrock/global.anthropic.claude-fable-5`)

Throughout, `<skill_dir>` is the directory containing this `SKILL.md`.

## Prerequisites

- `opencode` CLI installed and authenticated (`~/.local/share/opencode/auth.json`) for openai-ws,
  amazon-bedrock, zai-coding-plan, and kimi-for-coding.
- Skill config merges over global OpenCode config; Exa MCP and provider auth come from global setup.

## Step 1 — Write the question, verbatim

```bash
cat > /tmp/unifusion_question.txt <<'EOF'
<the user's question, verbatim>
EOF
```

## Step 2 — Run Unifusion

```bash
bash <skill_dir>/scripts/unifusion.sh /tmp/unifusion_question.txt
```

That command:

- builds a best-effort factual-only session brief when available
- assembles the orchestrator prompt
- starts one warm `opencode serve` daemon
- runs one `unifusion-orchestrator` attach thread (strategy + parallel panel dispatch + synthesis)
- kills the daemon and writes `analysis.md`, `final.md`, panelist reports, and provenance

Manifest lines:

```text
RUN_DIR=/tmp/unifusion-panel.XXXXXX
ORCH_PROMPT=/.../orch_prompt.md
ANALYSIS=/.../analysis.md
FINAL=/.../final.md
DELIVERABLE=/.../ .unifusion-deliverable.md
PROVENANCE=/.../2026-..._opencode-fable-....md
PANELIST gpt5.5 ok /.../reports/gpt5.5.md
...
```

## Step 3 — Present the result

Read `FINAL=` and present that answer. Use `ANALYSIS=` for the audit trail. Note any dropped panelists.

## Notes

- The session brief is **factual state only**, not a proposed solution.
- Panelists are read-only; the orchestrator has `task` + `write` (deliverable under cwd).
- All threads run with `--auto` for read/grep/webfetch approval in headless mode.
- Knobs: `UNIFUSION_ORCH_TIMEOUT` (default 1500s), `UNIFUSION_PANELISTS` (comma slug subset),
  `UNIFUSION_DELIVERABLE_REL` (default `.unifusion-deliverable.md`), `UNIFUSION_SAVE_RUN=0` to skip provenance.
- Archived entrypoints: `scripts/archive/unifusion_droid.sh`, `scripts/archive/unifusion_parallel_cli.sh`.
