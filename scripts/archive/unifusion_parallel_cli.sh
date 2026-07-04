#!/usr/bin/env bash
# unifusion_parallel_cli.sh — archived pre-Droid Unifusion entrypoint. Auto-detects every available panelist CLI, builds a
# best-effort shared session-context brief, assembles ONE canonical prompt, and fans the whole panel out
# in parallel and blind. Opus (via `claude`) is always a panelist; every external CLI that is installed joins
# too. The caller does only two things after this returns: JUDGE the answers and SAVE provenance.
#
# Usage:
#   unifusion.sh <question_file> [run_dir]
#
# - <question_file> : the user's question, VERBATIM (write it under /tmp before calling; do not put
#                     question.txt in the project directory; do not pre-digest it).
# - [run_dir]       : optional dir to hold this run's prompt/outputs; a fresh mktemp dir is used if omitted.
#
# What it does (folds in the old detect_panel + preflight + context + per-CLI launch steps):
#   1. Detects panelist CLIs: claude (Opus), codex (GPT-5.5), agy (Gemini), kimi (Kimi), glm-acp-agent (GLM).
#   2. Builds a FACTUAL session-context brief (summarize_session.sh, best-effort; skipped silently if it
#      can't be built). The identical brief is shared by every panelist — the panel's one allowed prior.
#   3. Assembles the canonical panelist prompt ([SESSION CONTEXT]? + [INSTRUCTIONS] + verbatim [TASK])
#      into <run_dir>/panel_prompt.md. This same file is what every panelist receives.
#   4. Fans out ALL available panelists as background jobs into <run_dir>/<label>_out.md, in parallel and
#      blind. Opus always runs; with NO external CLI present a SECOND Opus runs (the two-cold-Opus
#      opus4.8-4.8 fallback). A failing/missing panelist drops only itself; the run never aborts.
#   5. Waits for all, then prints a manifest the caller greps: RUN_DIR=, PANEL_PROMPT=, SLUG=, CONTEXT=,
#      and one `PANELIST <label> <ok|dropped:reason> <out_path>` line per panelist, plus a rough estimate.
#
# This script never judges and never writes final provenance — Opus (the orchestrator) is the sole judge
# and must stay a separate process from the claude-launched Opus panelist. Always exits 0 (degradation is
# per-panelist, never fatal).
#
# Env knobs (advanced; sensible defaults): UNIFUSION_TIMEOUT (per-panelist seconds, default 600),
# UNIFUSION_OPUS_MODEL (claude model, default opus), KIMI_MODEL, GLM_MODEL, AGY_MODEL,
# UNIFUSION_CONTEXT_PROVIDER + GEMINI_API_KEY/GOOGLE_API_KEY (enable the session brief).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

question_file="${1:?usage: unifusion.sh <question_file> [run_dir]}"
case "$question_file" in
  /*) ;;
  *) question_file="$(pwd -P)/$question_file" ;;
esac
if [ ! -s "$question_file" ]; then
  echo "[unifusion] question file is missing or empty: $question_file" >&2
  exit 2
fi

run_dir="${2:-}"
if [ -z "$run_dir" ]; then
  run_dir="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-panel.XXXXXX")"
else
  mkdir -p "$run_dir"
fi
case "$run_dir" in
  /*) ;;
  *) run_dir="$(cd "$run_dir" && pwd -P)" ;;
esac

have claude && claude_ok=true
have codex && codex_ok=true
have agy   && agy_ok=true
have_kimi  && kimi_ok=true
have glm-acp-agent && glm_ok=true

# ---- 2. best-effort shared session-context brief --------------------------------------------------
context_file="$run_dir/context.md"
context_state="none"
if bash "$SCRIPT_DIR/summarize_session.sh" "$context_file" >"$run_dir/context.log" 2>&1 && [ -s "$context_file" ]; then
  context_state="$context_file"
else
  rm -f "$context_file"
fi

# ---- 3. assemble the one canonical panelist prompt -----------------------------------------------
panel_prompt="$run_dir/panel_prompt.md"
{
  if [ "$context_state" != "none" ]; then
    echo "[SESSION CONTEXT — shared background, same for every panelist; factual only]"
    cat "$context_file"
    echo
  fi
  cat <<'INSTR'
[INSTRUCTIONS]
You are one of several independent experts answering the same question in parallel. You will not see the
others' answers. Research with web search and your local bash/tools, then return a complete, self-contained
answer in the user's language.

Web search:
- Search queries should be filtered to the past 60 days unless no good results are found.
- Prefer Exa MCP tools over native web search when Exa is available.

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
INSTR
  cat "$question_file"
} > "$panel_prompt"

# ---- 4. fan out, in parallel and blind -----------------------------------------------------------
labels=(); slugtokens=(); pids=(); outs=()

launch() {
  # launch <label> <slug_token> <out_basename> <runner> [args...]
  local label="$1" token="$2" outbase="$3"; shift 3
  local out="$run_dir/$outbase"
  "$@" "$panel_prompt" "$out" >"$run_dir/${label}.log" 2>&1 &
  pids+=("$!"); labels+=("$label"); slugtokens+=("$token"); outs+=("$out")
}

# Opus is always a panelist.
launch opus-A opus4.8 claude_out.md bash "$SCRIPT_DIR/run_claude.sh"

ext=0
$codex_ok && { launch gpt5.5         gpt5.5         codex_out.md  bash "$SCRIPT_DIR/run_codex.sh"  ; ext=$((ext+1)); }
$agy_ok   && { launch gemini3.5flash gemini3.5flash gemini_out.md bash "$SCRIPT_DIR/run_gemini.sh" ; ext=$((ext+1)); }
$kimi_ok  && { launch kimi2.7        kimi2.7        kimi_out.md   bash "$SCRIPT_DIR/run_kimi.sh"   ; ext=$((ext+1)); }
$glm_ok   && { launch glm5.2         glm5.2         glm_out.md    bash "$SCRIPT_DIR/run_glm.sh"   ; ext=$((ext+1)); }

# No external CLI at all -> run a SECOND cold Opus (the opus4.8-4.8 fallback).
if [ "$ext" -eq 0 ]; then
  launch opus-B opus4.8 claude_out_b.md bash "$SCRIPT_DIR/run_claude.sh"
fi

# ---- 5. wait, collect, report --------------------------------------------------------------------
statuses=()
for i in "${!pids[@]}"; do
  wait "${pids[$i]}"; statuses+=("$?")
done

reason_for() {
  case "$1" in
    0)   echo "ok" ;;
    124) echo "dropped:timeout" ;;
    127) echo "dropped:cli-missing" ;;
    2)   echo "dropped:bad-prompt" ;;
    *)   echo "dropped:exit-$1" ;;
  esac
}

# Slug = the tokens of panelists that actually returned a usable answer (driver-first opus4.8).
run_tokens=()
ok_count=0
for i in "${!labels[@]}"; do
  if [ "${statuses[$i]}" -eq 0 ] && [ -s "${outs[$i]}" ]; then
    run_tokens+=("${slugtokens[$i]}"); ok_count=$((ok_count+1))
  fi
done
if [ "${#run_tokens[@]}" -eq 0 ]; then
  slug="opus4.8"   # nothing returned; record the intended driver
else
  slug="$(IFS=-; echo "${run_tokens[*]}")"
fi

words="$(wc -w < "$question_file" | tr -d ' ')"
in_tokens=$(( words * 4 / 3 ))

echo "RUN_DIR=$run_dir"
echo "PANEL_PROMPT=$panel_prompt"
echo "CONTEXT=$context_state"
echo "SLUG=$slug"
echo "ESTIMATE=~${words} words (~${in_tokens} input tokens) sent to each of ${#labels[@]} panelists; per-panelist timeout ${UNIFUSION_TIMEOUT:-600}s; real cost is several x input."
echo "panel ($ok_count/${#labels[@]} returned):"
for i in "${!labels[@]}"; do
  printf 'PANELIST %s %s %s\n' "${labels[$i]}" "$(reason_for "${statuses[$i]}")" "${outs[$i]}"
done

exit 0
