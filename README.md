# unifusion

**Ask several frontier models the same hard question at once, let each work it alone, then have Opus 4.8
read every answer and synthesize one grounded reply.** A Claude Code skill: Opus 4.8 is always the driver
and the judge; every other model is an optional panelist that joins if its CLI is on `PATH`.

unifusion is a panel-and-synthesis harness in the **Fable / unifable** family — the same "verification as
procedure" instinct, applied across a panel of models. The whole bet
is **independence**: a panel only helps to the degree its members fail *differently*, so unifusion fans out
blind, passes the task verbatim, and lets the judge discount agreement that just echoes a shared prior.

## What it does

The orchestrator (Opus 4.8) follows a fixed pipeline; each stage is a small, replaceable script under
`scripts/`. `SKILL.md` is the entry point the model executes.

| Stage | Script | Role |
|---|---|---|
| Detect | `detect_panel.sh` | probe installed CLIs, print the richest panel `SLUG=` (driver-first `opus4.8` + one token per CLI); fall back to `opus4.8-4.8` |
| Brief *(optional)* | `resolve_session.sh` → `summarize_session.sh` → `compact-full-transcript.mjs` | resolve **this** session's transcript host-agnostically, summarize it to a **factual-only** brief shared identically by every panelist |
| Preflight | `preflight.sh` | non-blocking token/call estimate; never gates |
| Fan out | `run_codex.sh`, `run_gemini.sh`, `run_kimi.sh`, `run_devin.sh` + Opus subagents | every model answers the **same** prompt in parallel, blind, with web + bash, citing real evidence |
| Judge | `references/judge_rubric.md` | Opus 4.8 **merges** (Track A, code) or **synthesizes** (Track B, five sections) |
| Save | `save_run.sh` | timestamped provenance under `~/.claude/unifusion-runs/` |

Panel composition scales to whatever is installed, one panelist per CLI:

| CLI | Panelist | Slug token |
|---|---|---|
| *(built-in)* | Opus 4.8 (Agent subagents) | `opus4.8` |
| `codex` | GPT-5.5 | `-gpt5.5` |
| `agy` | Gemini 3.5 Flash | `-gemini3.5flash` |
| `kimi` | Kimi K2.7 | `-kimi2.7` |
| `devin` | GLM-5.2 | `-glm5.2` |

With no external CLI present, unifusion still runs as `opus4.8-4.8` — two independent Opus passes, judged.

## Independence is the mechanism

The scripts enforce what makes a panel work, so the orchestrator cannot accidentally undo it:

- **Blind.** Panelists never see each other's work. The judge is the only place the answers meet.
- **Verbatim.** The user's task is passed **unmodified**; the orchestrator is forbidden from pre-digesting
  or summarizing the question.
- **No personas.** No "skeptic / optimizer" lenses — those bias every member the same way. Diversity comes
  for free from running the same prompt cold across different systems.
- **The judge is separate.** Panelists are spawned *underneath* Opus and cannot call back out to spawn it,
  so the pipeline only flows one way (panel → judge). Opus reads the answers fresh, with none of its own to
  defend.
- **The one shared prior is bounded.** The optional session brief is identical for every panelist, carries
  **state only** (goals, decisions, files, constraints) with no proposed approach, and the judge treats
  agreement that merely restates it as a shared input, giving independently-reached agreement more weight.

## Session-transcript resolution

The session brief exists so panelists can answer questions that depend on what the session already
established. Building it means answering one deceptively hard question: *which transcript is "this
session"?* Different host CLIs store transcripts differently and most expose no session id. So
`resolve_session.sh` is host-agnostic:

1. **Detect the host by process ancestry** — walk `$$` → PID 1 reading `comm`/argv, classify the nearest
   agent ancestor as `claude | codex | droid | devin`.
2. **Resolve id → transcript path** per host (Claude `CLAUDE_CODE_SESSION_ID` / `--resume` →
   `~/.claude/projects/**/<id>.jsonl`; Codex `CODEX_THREAD_ID` → `~/.codex/sessions/**/rollout-*-<id>.jsonl`;
   Droid argv uuid → `~/.factory/sessions/<slug>/<id>.jsonl`; Devin `devin list --format json` scoped to the
   host cwd → `~/.local/share/devin/cli/transcripts/<id>.json`).
3. **Fingerprint-verify** — match the verbatim question (written to `/tmp/unifusion_question.txt`) with
   `grep -lF` to disambiguate cwd candidates and confirm the pick.
4. **Fail closed** — resolution must be a deterministic id or a unique fingerprint match, else exit non-zero
   and skip the brief. There is no newest-by-mtime guess; a wrong transcript would poison every panelist.

`compact-full-transcript.mjs` then summarizes the resolved transcript with **schema-constrained structured
output** (gemini-3.5-flash by default). Two foreign-format adapters feed its native-Claude pipeline —
`codexPayloadText` for Codex `.payload` records and `atifToClaudeJsonl` for Devin ATIF-v1.4 JSON — so all
four hosts summarize end-to-end. A content guard fails closed before any API call if a transcript yields no
citable text.

## Why a panel beats one model

The literature is consistent, and unifusion is built around the parts that hold up.

- **Panels of models beat the best single model.** Mixture-of-Agents (proposers feeding an aggregator) set
  state-of-the-art on AlpacaEval 2.0, MT-Bench and FLASK
  ([Wang et al., 2024](https://arxiv.org/abs/2406.04692)); a **diversity-aware** ensemble lands **+17 points**
  over the best single model on MMLU-Pro ([DFPE, EACL 2026](https://aclanthology.org/2026.findings-eacl.282/));
  multi-agent debate improves factuality and math
  ([Du et al., ICML 2024](https://composable-models.github.io/llm_debate/)). The gains track how
  *differently* the members reason.
- **It's the same lever frontier models use.** Test-time scaling — sample in parallel, then aggregate — is
  now a standard reasoning method with a full taxonomy
  ([Zhang et al., 2025](https://arxiv.org/abs/2503.24235)). unifusion does it across genuinely different
  model families.
- **Correlated errors are the failure mode.** Nine frontier judges were measured to carry only about **two**
  independent votes' worth of information, ~3/4 of the apparent independence lost to shared mistakes
  ([Nine Judges, Two Effective Votes, 2026](https://arxiv.org/abs/2605.29800)). Hence: blind fan-out,
  verbatim task, judge discounts echoed agreement.
- **Synthesis beats voting.** Majority vote discards the minority-correct answer; a learned aggregator beats
  it by recovering exactly those answers
  ([The Majority is not always right, 2025](https://arxiv.org/abs/2509.06870)). unifusion's judge weights
  whoever ran the code or cited the primary source.

One honest nuance: mixing models is not automatically better than running your single best model several
times — Self-MoA wins when one model dominates
([Rethinking Mixture-of-Agents, 2025](https://arxiv.org/abs/2502.00674)). That is exactly the `opus4.8-4.8`
fallback: two cold Opus runs, judged.

## Install

Drop this directory at `~/.agents/skills/unifusion/` (Claude Code's skills home; `~/.claude/skills` may
symlink there). Opus 4.8 runs the panel and judge with no extra setup. Optional panelists are added
automatically when their CLI is on `PATH` (see the CLI table above). The optional session brief needs Node
and a `GEMINI_API_KEY` (or `GOOGLE_API_KEY`); without them it is skipped.

## Use

Just ask: "run this through unifusion", `/unifusion`, or "get me a multi-model panel on X". Pin the size with
`/unifusion-3` (Opus + GPT-5.5 + Gemini) or `/unifusion-5` (all five families). A missing CLI drops only its
own panelist; the run never aborts over it.

## Verify

The release self-check is a single failable gate:

```bash
bash scripts/selfcheck.sh        # syntax, resolver identity + sha, content guard,
                                 # multi-provider, ATIF + Codex ingest, git hygiene
```

It exits non-zero on any failure and runs no paid API calls.

## Cost

Roughly N× a single answer in tokens, and as slow as the slowest panelist. That is the trade: you spend more
to stop being confidently wrong in the places where being wrong is what costs you.

## Layout

```
unifusion/
  SKILL.md              the run, step by step (what the model follows)
  AGENTS.md             maintainer notes (scripts, runner contract, safe-change rules)
  references/
    panel.md            panel composition + the independence rules
    judge_rubric.md     the two judge tracks (merge code / synthesize research)
  scripts/              detect_panel, preflight, resolver + summarizer, run_* panelists, save_run, helpers
```

## Sources

- Mixture-of-Agents Enhances Large Language Model Capabilities — Wang et al., 2024 — https://arxiv.org/abs/2406.04692
- DFPE: A Diverse Fingerprint Ensemble for Enhancing LLM Performance — ACL Findings (EACL) 2026 — https://aclanthology.org/2026.findings-eacl.282/
- Improving Factuality and Reasoning in Language Models through Multiagent Debate — Du et al., ICML 2024 — https://composable-models.github.io/llm_debate/
- A Survey on Test-Time Scaling in Large Language Models — Zhang et al., 2025 — https://arxiv.org/abs/2503.24235
- Nine Judges, Two Effective Votes: Correlated Errors Undermine LLM Evaluation Panels — 2026 — https://arxiv.org/abs/2605.29800
- The Majority is not always right: RL training for solution aggregation — 2025 — https://arxiv.org/abs/2509.06870
- Rethinking Mixture-of-Agents: Is Mixing Different LLMs Beneficial? (Self-MoA) — 2025 — https://arxiv.org/abs/2502.00674
