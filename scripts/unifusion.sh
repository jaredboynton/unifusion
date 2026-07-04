#!/usr/bin/env bash
# unifusion.sh — run a frontier-research panel via a single Fable orchestrator on OpenCode.
#
# Usage:
#   unifusion.sh <question_file> [run_dir]
#
# Flow:
#   1. Build a factual shared context brief when available.
#   2. Assemble one orchestrator prompt with that brief plus the verbatim task.
#   3. Start ONE warm `opencode serve` daemon (skill-local config, merged over the
#      user's global providers/auth/MCP).
#   4. Run ONE `unifusion-orchestrator` attach thread: Fable devises a research strategy,
#      dispatches panelist subagents in parallel via the `task` tool, synthesizes, and
#      returns [FINAL]/[ANALYSIS] plus an optional deliverable file under cwd.
#   5. Kill the daemon, persist analysis/final artifacts, panelist reports, and provenance.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

OPENCODE_BIN="${UNIFUSION_OPENCODE_BIN:-opencode}"
OPENCODE_CFG="${UNIFUSION_OPENCODE_CONFIG:-$SCRIPT_DIR/../opencode/opencode.json}"
PARSE_EVENTS="$SCRIPT_DIR/../opencode/parse_events.py"

orch_agent="${UNIFUSION_ORCH_AGENT:-unifusion-orchestrator}"

question_file="${1:?usage: unifusion.sh <question_file> [run_dir]}"
case "$question_file" in
  /*) ;;
  *) question_file="$(pwd -P)/$question_file" ;;
esac
if [ ! -s "$question_file" ]; then
  echo "[unifusion] question file is missing or empty: $question_file" >&2
  exit 2
fi
if ! have "$OPENCODE_BIN"; then
  echo "[unifusion] opencode CLI not installed — cannot run OpenCode-native Unifusion." >&2
  exit 127
fi
if ! have python3; then
  echo "[unifusion] python3 not installed — cannot parse opencode JSON output." >&2
  exit 127
fi
if ! have curl; then
  echo "[unifusion] curl not installed — cannot talk to the opencode server." >&2
  exit 127
fi
if [ ! -s "$OPENCODE_CFG" ]; then
  echo "[unifusion] missing opencode config: $OPENCODE_CFG" >&2
  exit 2
fi
case "$OPENCODE_CFG" in
  /*) ;;
  *) OPENCODE_CFG="$(cd "$(dirname "$OPENCODE_CFG")" && pwd -P)/$(basename "$OPENCODE_CFG")" ;;
esac

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
review_root="$run_dir/reports"
mkdir -p "$review_root"

orch_timeout="${UNIFUSION_ORCH_TIMEOUT:-1500}"
server_wait="${UNIFUSION_SERVER_WAIT:-30}"

# Panelist slug tokens for provenance (orchestrator dispatches all four by default).
default_panelists="gpt5.5 grok4.3 glm5.2 kimi2.7"
panelist_slugs=()
if [ -n "${UNIFUSION_PANELISTS:-}" ]; then
  IFS=',' read -r -a panelist_slugs <<<"${UNIFUSION_PANELISTS}"
else
  read -r -a panelist_slugs <<<"$default_panelists"
fi

# Deliverable path under cwd (orchestrator can write here; external /tmp is auto-rejected).
deliverable_rel="${UNIFUSION_DELIVERABLE_REL:-.unifusion-deliverable.md}"
deliverable_path="$cwd/$deliverable_rel"
rm -f "$deliverable_path"

# ---- best-effort shared session-context brief ----------------------------------------------------
context_file="$run_dir/context.md"
context_state="none"
if bash "$SCRIPT_DIR/summarize_session.sh" "$context_file" >"$run_dir/context.log" 2>&1 && [ -s "$context_file" ]; then
  context_state="$context_file"
else
  rm -f "$context_file"
fi

# ---- orchestrator prompt -------------------------------------------------------------------------
orch_prompt="$run_dir/orch_prompt.md"
{
  if [ "$context_state" != "none" ]; then
    echo "[SESSION CONTEXT — shared factual background; not a proposed approach]"
    cat "$context_file"
    echo
  fi
  cat <<EOF
[DELIVERABLE PATH]
Write the user-facing final answer (markdown body only, no [FINAL] markers) to this repo-relative path:
${deliverable_rel}

[PANELISTS]
Dispatch these subagents (all four unless noted): panelist-gpt (GPT-5.5), panelist-grok (Grok 4.3), panelist-glm (GLM-5.2), panelist-kimi (Kimi K2.7).
Expected slug tokens for this run: ${panelist_slugs[*]}.

[TASK]
Find the strongest current technical approach for the user's request below. Devise complementary research
angles, dispatch all panelists in ONE turn, synthesize, and produce [FINAL] and [ANALYSIS].

[USER REQUEST — verbatim]
EOF
  cat "$question_file"
} >"$orch_prompt"

analysis_path="$run_dir/analysis.md"
final_path="$run_dir/final.md"
serve_log="$run_dir/serve.log"
orch_events="$run_dir/orchestrator.events.json"
orch_log="$run_dir/orchestrator.log"

# ---- start the warm daemon -----------------------------------------------------------------------
opencode_pids() { pgrep -f "$OPENCODE_BIN" 2>/dev/null | sort -u; }
baseline_pids=" $(opencode_pids | tr '\n' ' ') "

server_pid=""
cleanup() {
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null
  fi
  local p
  for p in $(opencode_pids); do
    case "$baseline_pids" in *" $p "*) continue ;; esac
    kill "$p" 2>/dev/null || true
  done
  for _ in 1 2 3 4 5; do
    local remaining=""
    for p in $(opencode_pids); do
      case "$baseline_pids" in *" $p "*) continue ;; esac
      remaining="yes"
    done
    [ -z "$remaining" ] && break
    sleep 0.2
  done
  for p in $(opencode_pids); do
    case "$baseline_pids" in *" $p "*) continue ;; esac
    kill -9 "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

OPENCODE_CONFIG="$OPENCODE_CFG" "$OPENCODE_BIN" serve --port 0 </dev/null >"$serve_log" 2>&1 &
server_pid=$!

server_url=""
deadline=$(( $(date +%s) + server_wait ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "[unifusion] opencode serve exited during startup; tail of log:" >&2
    tail -20 "$serve_log" >&2
    exit 1
  fi
  server_url="$(grep -oE 'http://127\.0\.0\.1:[0-9]+' "$serve_log" | head -1)"
  [ -n "$server_url" ] && break
  sleep 0.25
done
if [ -z "$server_url" ]; then
  echo "[unifusion] opencode serve did not report a listen URL within ${server_wait}s; tail of log:" >&2
  tail -20 "$serve_log" >&2
  exit 1
fi

orch_session="$(curl -s -X POST "${server_url}/session" -H 'content-type: application/json' -d '{}' \
  | python3 -c 'import sys,json;print((json.load(sys.stdin) or {}).get("id",""))' 2>/dev/null)"
if [ -z "$orch_session" ]; then
  echo "[unifusion] could not create an orchestrator session." >&2
  exit 1
fi
printf '%s\n' "$orch_session" >"$run_dir/orchestrator.session"

# ---- orchestrator run ----------------------------------------------------------------------------
orch_args=(run --attach "$server_url" --session "$orch_session" --dir "$cwd" --agent "$orch_agent" --auto --format json)
OPENCODE_CONFIG="$OPENCODE_CFG" _run_with_timeout "$orch_timeout" \
  "$OPENCODE_BIN" "${orch_args[@]}" <"$orch_prompt" >"$orch_events" 2>"$orch_log"
orch_status=$?

if [ "$orch_status" -ne 0 ] || [ ! -s "$orch_events" ]; then
  echo "[unifusion] orchestrator failed (status $orch_status); tail of log:" >&2
  tail -20 "$orch_log" >&2
  exit 1
fi

# ---- extract panelist reports from task tool events ----------------------------------------------
python3 - "$orch_events" "$review_root" "$PARSE_EVENTS" <<'PY'
import importlib.util
import json
import pathlib
import sys

events_path, review_root, parser_path = sys.argv[1:4]

spec = importlib.util.spec_from_file_location("parse_events", parser_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

slug_map = {
    "panelist-gpt": "gpt5.5",
    "panelist-grok": "grok4.3",
    "panelist-glm": "glm5.2",
    "panelist-kimi": "kimi2.7",
}

root = pathlib.Path(review_root)
root.mkdir(parents=True, exist_ok=True)

for task in mod.extract_task_results(events_path):
    subagent = task.get("subagent") or "unknown"
    slug = slug_map.get(subagent, subagent.replace("panelist-", ""))
    output = (task.get("output") or "").strip()
    status = task.get("status") or ""
    out_path = root / f"{slug}.md"
    if output:
        out_path.write_text(output + ("\n" if not output.endswith("\n") else ""))
    else:
        out_path.write_text(f"_(empty; task status={status})_\n")
PY

# ---- parse [FINAL] / [ANALYSIS] from orchestrator stream ----------------------------------------
python3 - "$orch_events" "$final_path" "$analysis_path" "$PARSE_EVENTS" <<'PY'
import importlib.util
import pathlib
import re
import sys

events_path, final_path, analysis_path, parser_path = sys.argv[1:5]

spec = importlib.util.spec_from_file_location("parse_events", parser_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
result = mod.extract_final_text(events_path)


def extract(name: str) -> str:
    m = re.search(rf"\[{name}\]\s*(.*?)\s*\[/{name}\]", result, re.S)
    return (m.group(1).strip() + "\n") if m else ""


final = extract("FINAL")
analysis = extract("ANALYSIS")
if not final:
    final = result.rstrip() + ("\n" if result else "")
if not analysis:
    analysis = result.rstrip() + ("\n" if result else "")

pathlib.Path(final_path).write_text(final)
pathlib.Path(analysis_path).write_text(analysis)
PY

if ! _has_content "$final_path"; then
  if _has_content "$deliverable_path"; then
    cp "$deliverable_path" "$final_path"
  else
    echo "[unifusion] empty final answer from orchestrator." >&2
    exit 1
  fi
fi
if ! _has_content "$analysis_path"; then
  echo "[unifusion] empty analysis from orchestrator." >&2
  exit 1
fi

# ---- panelist manifest from task results ---------------------------------------------------------
ok_labels=(); missing_labels=(); label_specs=()
for slug in "${panelist_slugs[@]}"; do
  report="$review_root/${slug}.md"
  if _has_content "$report" && ! grep -q '^_(empty' "$report" 2>/dev/null; then
    ok_labels+=("$slug")
    label_specs+=("${slug}=${report}")
  else
    missing_labels+=("${slug} (no-report)")
  fi
done

# ---- provenance + manifest -----------------------------------------------------------------------
cleanup
server_pid=""
trap - EXIT INT TERM

slug="opencode-fable"
if [ "${#ok_labels[@]}" -gt 0 ]; then
  slug="opencode-fable-$(IFS=-; echo "${ok_labels[*]}")"
fi

panel_note=""
if [ "${#missing_labels[@]}" -gt 0 ]; then
  panel_note="dropped: $(IFS=', '; echo "${missing_labels[*]}")"
fi

words="$(wc -w <"$question_file" | tr -d ' ')"
in_tokens=$((words * 4 / 3))
estimate="~${words} words (~${in_tokens} input tokens) sent to one Fable orchestrator on a warm opencode daemon; orchestrator dispatches ${#panelist_slugs[@]} panelist subagents via task; orchestrator timeout ${orch_timeout}s."

provenance_path=""
if [ "${UNIFUSION_SAVE_RUN:-1}" = "1" ]; then
  save_env=()
  [ -n "$panel_note" ] && save_env+=(UNIFUSION_PANEL_NOTE="$panel_note")
  [ "$context_state" != "none" ] && save_env+=(UNIFUSION_CONTEXT_FILE="$context_file")
  save_env+=(UNIFUSION_ESTIMATE="$estimate")
  provenance_path="$(env "${save_env[@]}" bash "$SCRIPT_DIR/save_run.sh" "$slug" "$question_file" "$analysis_path" "$final_path" "${label_specs[@]}")"
fi

echo "RUN_DIR=$run_dir"
echo "ORCH_PROMPT=$orch_prompt"
echo "CONTEXT=$context_state"
echo "OPENCODE_CONFIG=$OPENCODE_CFG"
echo "SERVER_URL=$server_url"
echo "DELIVERABLE=$deliverable_path"
echo "SLUG=$slug"
echo "ANALYSIS=$analysis_path"
echo "FINAL=$final_path"
[ -n "$provenance_path" ] && echo "PROVENANCE=$provenance_path"
echo "ESTIMATE=$estimate"
echo "panel (${#ok_labels[@]}/${#panelist_slugs[@]} returned):"
for slug in "${panelist_slugs[@]}"; do
  report="$review_root/${slug}.md"
  if printf '%s\n' "${ok_labels[@]}" | grep -qx "$slug"; then
    printf 'PANELIST %s ok %s\n' "$slug" "$report"
  else
    printf 'PANELIST %s dropped:no-report %s\n' "$slug" "$report"
  fi
done

exit 0
