#!/usr/bin/env bash
# save_run.sh — write the provenance .md for one Unifusion run, on the INTERNAL disk only.
#
# Usage:
#   save_run.sh <slug> <question_file> <analysis_file> <final_file> <run_dir>
#   save_run.sh <slug> <question_file> <analysis_file> <final_file> [LABEL=path ...]
#
# - <slug>           : the panel slug actually run (e.g. opus4.8-gpt5.5-gemini3.5flash)
# - <question_file>  : the user's question, verbatim
# - <analysis_file>  : the judge's 5-section structured analysis
# - <final_file>     : the grounded final answer
# - <run_dir>        : the unifusion.sh run dir — raw panelist answers (*_out.md) are auto-discovered
#                      from it (the simple path). Pass a single directory here.
# - LABEL=path       : OR list them explicitly, one per panelist, raw answer file (e.g.
#                      "opus-A=/tmp/..._opusA.md", "gpt5.5=/tmp/unifusion_codex_out.md")
#
# Optional env:
#   UNIFUSION_PANEL_NOTE   degradation note (e.g. "gemini dropped: agy empty -> opus4.8-gpt5.5")
#   UNIFUSION_ESTIMATE     the preflight estimate string, for the record
#   UNIFUSION_CONTEXT_FILE the injected session-context brief (recorded so the run is reproducible and
#                       it is clear the panelists shared this prior)
#
# Output: prints the path of the .md it wrote. Writes ONLY under
# ${UNIFABLE_DATA:-$HOME/.unifable}/unifusion-runs/ (internal disk) — never ~/Projects or
# /Volumes/4T (the external 4T is TCC-blocked).

set -uo pipefail

slug="${1:?usage: save_run.sh <slug> <question_file> <analysis_file> <final_file> [LABEL=path ...]}"
question_file="${2:?need question_file}"
analysis_file="${3:?need analysis_file}"
final_file="${4:?need final_file}"
shift 4

# Auto-discover mode: a single directory argument => map its *_out.md files to labels.
if [ "$#" -eq 1 ] && [ -d "$1" ]; then
  run_dir="$1"; shift
  label_for() {
    case "$1" in
      cb_out)     echo "opus-A" ;;
      cb_out_b)   echo "opus-B" ;;
      codex_out)  echo "gpt5.5" ;;
      gemini_out) echo "gemini3.5flash" ;;
      kimi_out)   echo "kimi2.7" ;;
      glm_out)    echo "glm5.2" ;;
      *)          echo "$1" ;;
    esac
  }
  set --
  for f in "$run_dir"/*_out.md; do
    [ -e "$f" ] || continue
    stem="$(basename "$f" .md)"
    set -- "$@" "$(label_for "$stem")=$f"
  done
fi

RUNS_DIR="${UNIFABLE_DATA:-$HOME/.unifable}/unifusion-runs"
mkdir -p "$RUNS_DIR"
ts="$(date +%Y-%m-%d_%H%M%S)"
out="$RUNS_DIR/${ts}_${slug}.md"

emit_file() {
  if [ -f "$1" ] && [ -s "$1" ]; then
    cat "$1"
    # guarantee a trailing newline so the next markdown block is never glued on
    [ -n "$(tail -c1 "$1")" ] && echo
  else
    echo "_(empty / not available)_"
  fi
}

{
  echo "# Unifusion run — $ts"
  echo
  echo "- **Panel run** : \`$slug\`"
  [ -n "${UNIFUSION_PANEL_NOTE:-}" ] && echo "- **Degradation** : ${UNIFUSION_PANEL_NOTE}"
  [ -n "${UNIFUSION_ESTIMATE:-}" ]   && echo "- **Estimate (preflight)** : ${UNIFUSION_ESTIMATE}"
  echo
  echo "## Question (verbatim)"
  echo
  echo '```'
  emit_file "$question_file"
  echo '```'
  echo
  if [ -n "${UNIFUSION_CONTEXT_FILE:-}" ] && [ -s "${UNIFUSION_CONTEXT_FILE:-}" ]; then
    echo "## Session context (injected into every panelist prompt)"
    echo
    emit_file "$UNIFUSION_CONTEXT_FILE"
    echo
  fi
  echo "## Raw panelist answers"
  if [ "$#" -eq 0 ]; then
    echo
    echo "_(no panelist provided)_"
  fi
  for spec in "$@"; do
    label="${spec%%=*}"
    path="${spec#*=}"
    echo
    echo "### $label"
    echo
    emit_file "$path"
    echo
  done
  echo "## Analysis (consensus / contradictions / partial coverage / unique insights / blind spots)"
  echo
  emit_file "$analysis_file"
  echo
  echo "## Final answer"
  echo
  emit_file "$final_file"
  echo
} > "$out"

echo "$out"
