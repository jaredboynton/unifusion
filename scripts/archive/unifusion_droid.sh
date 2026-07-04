#!/usr/bin/env bash
# unifusion.sh — run one Droid root orchestrator that launches frontier-research architect droids in
# parallel, synthesizes their findings, and writes a manifest plus final artifacts.
#
# Usage:
#   unifusion.sh <question_file> [run_dir]
#
# Flow:
#   1. Build a factual shared context brief when available.
#   2. Assemble one canonical panel prompt with that brief plus the verbatim task.
#   3. Launch a single `droid exec` root run that uses Task to fan out architect droids in parallel,
#      then synthesizes their reports in the root session.
#   4. Persist analysis/final artifacts and write a provenance record.

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
if ! have droid; then
  echo "[unifusion] droid CLI not installed — cannot run Droid-native Unifusion." >&2
  exit 127
fi
if ! have python3; then
  echo "[unifusion] python3 not installed — cannot parse droid JSON output." >&2
  exit 127
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

cwd="$(pwd -P)"
review_session="${UNIFUSION_REVIEW_SESSION:-$(basename "$run_dir")}"
uid="${UNIFUSION_UID:-$(date +%Y%m%d_%H%M%S)_$$}"
review_root="${HOME}/.factory/reviews/${review_session}/${uid}"
mkdir -p "$review_root"

droid_model="${UNIFUSION_DROID_MODEL:-custom:GPT-5.5-OAuth}"
droid_reasoning="${UNIFUSION_DROID_REASONING_EFFORT:-high}"
droid_timeout="${UNIFUSION_DROID_TIMEOUT:-1800}"

label_for_droid() {
  case "$1" in
    architect) echo "gpt5.5" ;;
    architect-opus) echo "opus4.8" ;;
    architect-glm) echo "glm5.2" ;;
    architect-kimi) echo "kimi2.7" ;;
    *) echo "$1" ;;
  esac
}

slug_for_droid() {
  case "$1" in
    architect) echo "gpt5.5" ;;
    architect-opus) echo "opus4.8" ;;
    architect-glm) echo "glm5.2" ;;
    architect-kimi) echo "kimi2.7" ;;
    *) echo "$1" ;;
  esac
}

report_path_for_droid() {
  printf '%s/%s.md\n' "$review_root" "$1"
}

droid_names=()
if [ -n "${UNIFUSION_DROIDS:-}" ]; then
  IFS=',' read -r -a droid_names <<<"${UNIFUSION_DROIDS}"
else
  droid_names=(architect architect-opus architect-glm architect-kimi)
fi

# ---- best-effort shared session-context brief ----------------------------------------------------
context_file="$run_dir/context.md"
context_state="none"
if bash "$SCRIPT_DIR/summarize_session.sh" "$context_file" >"$run_dir/context.log" 2>&1 && [ -s "$context_file" ]; then
  context_state="$context_file"
else
  rm -f "$context_file"
fi

# ---- canonical panel prompt ----------------------------------------------------------------------
panel_prompt="$run_dir/panel_prompt.md"
{
  if [ "$context_state" != "none" ]; then
    echo "[SESSION CONTEXT — shared factual background, same for every architect; not a proposed approach]"
    cat "$context_file"
    echo
  fi
  cat <<'EOF'
[TASK]
Find the strongest current technical approach for the user's request below. Optimize for literal best-known
practice backed by current evidence, not habit or average convention. Use local repo evidence when relevant,
and external primary sources such as official docs, flagship GitHub repositories, papers, benchmarks, release
notes, and maintainer guidance.

[USER REQUEST — verbatim]
EOF
  cat "$question_file"
} >"$panel_prompt"

analysis_path="$run_dir/analysis.md"
final_path="$run_dir/final.md"
droid_prompt="$run_dir/droid_prompt.md"
droid_result="$run_dir/droid_result.json"
droid_log="$run_dir/droid.log"

{
  cat <<EOF
You are Unifusion's root orchestrator running inside one Droid exec session.

Goal:
Run a frontier-research architecture panel on the task in \`$panel_prompt\`, synthesize the results in the
root session, and return the final answer plus a structured panel analysis.

Working context:
- Repo cwd: $cwd
- Panel prompt file: $panel_prompt
- Shared factual session context file: $context_state
- Review session: $review_session
- Review UID: $uid
- Review root: $review_root
- Final answer path (written by the shell after you return): $final_path

Rules:
- Read \`$panel_prompt\` first.
- Do not answer from memory when evidence is available.
- Do not edit repo files, settings, hooks, droid configs, or credentials.
- The only files that may be created or edited are the architect report files under \`$review_root\`.
- Use Task tool calls in the same assistant message when launching the architect droids so they run in
  parallel.
- If one or more architect droids fail or do not produce a report file, continue with the remaining reports
  and explicitly note the dropped panelists in the final answer.

Architect droids to launch:
EOF
  for droid_name in "${droid_names[@]}"; do
    printf -- "- %s -> %s\n" "$droid_name" "$(report_path_for_droid "$droid_name")"
  done
  cat <<EOF

For each architect droid, use a Task prompt with this shape:
- Goal: determine the strongest current approach for the task in \`$panel_prompt\`
- Context: repo cwd \`$cwd\`, report path, reviewer-name, session, UID
- Constraints: use repo evidence plus primary external sources; optimize for best current approach; do not
  modify repo files; write only the report file
- Questions: what is the best approach, why it beats alternatives, and what concrete implementation guidance
  follows for this repo/task
- Expected output: write the report and return only the absolute report path

After the architect Task calls finish:
1. Verify which report files exist.
2. Read every existing architect report file.
3. Synthesize them yourself in the root session.
4. Return exactly this shape and nothing else:

[FINAL]
<user-facing final answer in markdown>
[/FINAL]

[ANALYSIS]
<structured panel analysis in markdown>
[/ANALYSIS]

The FINAL section must:
- Lead with the single recommended approach.
- Explain briefly why it is strongest.
- Give concrete implementation guidance the outer orchestrator can follow.
- Name major caveats, open risks, and any dropped panelists.

The ANALYSIS section must include:
- Participating panelists
- Consensus findings
- Single-panelist or disputed findings
- Rejected alternatives
- Remaining risks or unknowns

Avoid step narration, path dumps, and tool chatter outside those markers.
EOF
} >"$droid_prompt"

words="$(wc -w <"$question_file" | tr -d ' ')"
in_tokens=$((words * 4 / 3))

_run_with_timeout "$droid_timeout" droid exec \
  --model "$droid_model" \
  --reasoning-effort "$droid_reasoning" \
  --auto high \
  --cwd "$cwd" \
  --enabled-tools Read,LS,Grep,Glob,WebSearch,FetchUrl,Create,Edit,ApplyPatch,Task \
  --output-format json \
  -f "$droid_prompt" \
  >"$droid_result" 2>"$droid_log"
status=$?

if [ "$status" -eq 124 ]; then
  echo "[unifusion] droid exec timed out after ${droid_timeout}s; tail of log:" >&2
  tail -20 "$droid_log" >&2
  exit 124
fi
if [ "$status" -ne 0 ]; then
  echo "[unifusion] droid exec exited $status; tail of log:" >&2
  tail -20 "$droid_log" >&2
  exit 1
fi

python3 - "$droid_result" "$final_path" "$analysis_path" <<'PY'
import json
import pathlib
import re
import sys

result_path = pathlib.Path(sys.argv[1])
final_path = pathlib.Path(sys.argv[2])
analysis_path = pathlib.Path(sys.argv[3])
payload = json.loads(result_path.read_text())
result = payload.get("result") or ""

def extract(name: str) -> str:
    m = re.search(rf"\[{name}\]\s*(.*?)\s*\[/{name}\]", result, re.S)
    return (m.group(1).strip() + "\n") if m else ""

final = extract("FINAL")
analysis = extract("ANALYSIS")

if not final:
    final = result.rstrip() + ("\n" if result else "")
if not analysis:
    analysis = result.rstrip() + ("\n" if result else "")

final_path.write_text(final)
analysis_path.write_text(analysis)
PY

if ! _has_content "$final_path"; then
  echo "[unifusion] empty final answer from droid exec." >&2
  exit 1
fi
if ! _has_content "$analysis_path"; then
  echo "[unifusion] empty analysis from droid exec." >&2
  exit 1
fi

droid_session_id="$(python3 - "$droid_result" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1]))
print(payload.get("session_id", ""))
PY
)"

ok_labels=()
missing_labels=()
label_specs=()
for droid_name in "${droid_names[@]}"; do
  label="$(label_for_droid "$droid_name")"
  report_path="$(report_path_for_droid "$droid_name")"
  if [ -s "$report_path" ]; then
    ok_labels+=("$label")
    label_specs+=("${label}=${report_path}")
  else
    missing_labels+=("$label")
  fi
done

slug="droidexec"
if [ "${#ok_labels[@]}" -gt 0 ]; then
  slug="droidexec-$(IFS=-; echo "${ok_labels[*]}")"
fi

panel_note=""
if [ "${#missing_labels[@]}" -gt 0 ]; then
  panel_note="dropped: $(IFS=', '; echo "${missing_labels[*]}")"
fi

estimate="~${words} words (~${in_tokens} input tokens) sent to one Droid root orchestrator, which fanned out ${#droid_names[@]} architect droids in parallel and synthesized their reports; overall timeout ${droid_timeout}s."

provenance_path=""
if [ "${UNIFUSION_SAVE_RUN:-1}" = "1" ]; then
  save_env=()
  [ -n "$panel_note" ] && save_env+=(UNIFUSION_PANEL_NOTE="$panel_note")
  [ "$context_state" != "none" ] && save_env+=(UNIFUSION_CONTEXT_FILE="$context_file")
  save_env+=(UNIFUSION_ESTIMATE="$estimate")
  provenance_path="$(env "${save_env[@]}" bash "$SCRIPT_DIR/save_run.sh" "$slug" "$question_file" "$analysis_path" "$final_path" "${label_specs[@]}")"
fi

echo "RUN_DIR=$run_dir"
echo "PANEL_PROMPT=$panel_prompt"
echo "DROID_PROMPT=$droid_prompt"
echo "CONTEXT=$context_state"
echo "REVIEW_SESSION=$review_session"
echo "UID=$uid"
echo "SLUG=$slug"
echo "ANALYSIS=$analysis_path"
echo "FINAL=$final_path"
echo "DROID_SESSION_ID=$droid_session_id"
[ -n "$provenance_path" ] && echo "PROVENANCE=$provenance_path"
echo "ESTIMATE=$estimate"
echo "panel (${#ok_labels[@]}/${#droid_names[@]} returned):"
for droid_name in "${droid_names[@]}"; do
  label="$(label_for_droid "$droid_name")"
  report_path="$(report_path_for_droid "$droid_name")"
  if [ -s "$report_path" ]; then
    printf 'PANELIST %s ok %s\n' "$label" "$report_path"
  else
    printf 'PANELIST %s dropped:missing %s\n' "$label" "$report_path"
  fi
done

exit 0
