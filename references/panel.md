# The panel

Unifusion's power comes from **independent answers, synthesized**: the same question goes to several models at
once, each works it cold with no knowledge of the others, and a judge fuses their answers. Independent
agreement is high-confidence; independent disagreement is the signal worth surfacing.

## No lenses, no personas

Do not assign panelists "roles" or "stances" (skeptic, optimizer, first-principles, etc.). That biases
*how* each one reasons and corrupts the independence that makes the panel work. Pass every panelist the
user's task **verbatim** and let each answer it straight.

The diversity is already there for free: running the same prompt independently produces different reasoning
paths, tool calls, and source selections — even when it's the *same model answering twice*. You harvest
diversity from independence; you do not manufacture it.

## Independence is the rule

Panelists must never see each other's work. Don't show one panelist another's answer, and don't let the
orchestrator pre-digest or summarize the *task itself* before handing it over. The judge is the only place
the answers meet. Cross-pollination before the judge defeats the entire mechanism.

## Shared session context (the one deliberate exception)

When Unifusion runs inside a working session, the orchestrator may prepend a single **session-context brief**
to every panelist's prompt (see SKILL.md Step 1.5). This is the only shared prior the panel is allowed, and
it exists so panelists can answer questions that depend on what the session already established instead of
guessing blind. It is bounded on purpose:

- It is **identical for every panelist**, so any pull it exerts lands uniformly across the whole panel.
- It carries **factual state only** — goals, decisions, constraints, files, current state, open questions —
  and never an approach or a hint at the answer. A summarizer that smuggled in a recommendation would turn
  an independent panel into a correlated one.
- It is **best-effort**: when it can't be built (no session transcript, or no API key) the panel fans out
  on the verbatim task alone.

Because this prior is shared, the judge gives agreement that merely restates the brief less weight than
agreement the panelists reached independently (see `judge_rubric.md`). The no-lenses and no-cross-pollination
rules above still hold: panelists never see each other's answers, and the task is still passed verbatim.

## Panel composition per slug

- `opus4.8-4.8` — the **same prompt run twice** as two independent Opus 4.8 panelists (Agent subagents),
  then judged. Same model, two cold runs.
- `opus4.8-gpt5.5` — Opus 4.8 and GPT-5.5 (codex) answer **in parallel**, then judged.
- `opus4.8-gpt5.5-gemini3.5flash` — Opus 4.8, GPT-5.5, and Gemini 3.5 Flash answer in parallel, then judged.
- `opus4.8-gpt5.5-gemini3.5flash-kimi2.7-glm5.2` — the full panel: Opus 4.8, GPT-5.5 (codex), Gemini 3.1
  Pro (agy), Kimi K2.7 (kimi), and GLM-5.2 (devin) answer in parallel, then judged.

`detect_panel.sh` recommends the richest panel the machine supports, appending one token per available
external CLI (`-gpt5.5` codex, `-gemini3.5flash` agy, `-kimi2.7` kimi, `-glm5.2` devin) and falling back to
`opus4.8-4.8` when none is present. A missing or failing CLI drops only its own panelist; the rest of the
panel continues.

In every case Opus 4.8 is also the judge/synthesizer, and the judge is kept separate from the panelists
(the panelists are spawned; the orchestrator judges) so the synthesis reads the answers fresh rather than
defending one it wrote itself. Opus always judges and writes the final answer — the pipeline can't be
reversed, since the panelist models can't call back out to spawn Opus.

## Prompt each panelist gets

Each panelist receives the user's task **verbatim**, the optional shared session-context brief, and one
uniform instruction block. The instruction is the same for every panelist, so it adds no lens and nudges
no conclusion — it only sets the standard of evidence and currency every answer must meet. Assemble the
prompt in this order:

```
[SESSION CONTEXT — shared background, same for every panelist; factual only]   (omit if unavailable)
<the brief from summarize_session.sh>

[INSTRUCTIONS]
You are one of several independent experts answering the same question in parallel. You will not see the
others' answers. Research with web search and your local bash/tools, then return a complete, self-contained
answer in the user's language.

Ground every claim in evidence you actually gathered this run:
- For any claim about this codebase or local system, cite the concrete file path and line, or the command
  and its output, that you actually read or ran. Run the code or read the file; never assert from memory.
- For any claim from the web, cite the source URL you actually opened, and prefer primary or official
  sources over second-hand summaries.
- Label anything you could not verify as unverified.

Use current information:
- Verify the latest stable version of any library, framework, tool, or API on the web this run; never rely
  on a recalled version number.
- Check the current official documentation for any API you reference, and say when behavior is
  version-specific.
- Prefer actively maintained repositories and recent, still-relevant papers; note the release or
  publication date of sources you lean on, and flag anything deprecated or superseded as of today.

[TASK — answer this, verbatim]
<the user's question>
```

Nothing beyond this block — no persona, no stance, no framing that points at an answer.
