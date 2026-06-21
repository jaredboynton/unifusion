#!/usr/bin/env bash
# preflight.sh — pre-run, NON-BLOCKING sanity check the orchestrator shows before fanning out.
#
# Usage:
#   preflight.sh <slug> <prompt_file>
#
# Prints: a rough token/call estimate (so a heavy question doesn't surprise you), the per-panelist
# timeout, a reminder about each external CLI, and the session-context note. It NEVER blocks — it
# only informs. Always exits 0.

set -uo pipefail

slug="${1:?usage: preflight.sh <slug> <prompt_file>}"
prompt_file="${2:?usage: preflight.sh <slug> <prompt_file>}"

# Panelist count = number of '-'-separated tokens in the slug (each token is one panelist run).
n="$(printf '%s' "$slug" | awk -F- '{print NF}')"
[ -z "$n" ] && n=2

words=0
[ -f "$prompt_file" ] && words="$(wc -w < "$prompt_file" | tr -d ' ')"
# ~1.3 tokens/word, very rough; output usually dwarfs input on deep questions.
in_tokens=$(( words * 4 / 3 ))

echo "preflight (informational — not a gate):"
echo "  panel        : $slug  ($n panelists + 1 Opus judge pass)"
echo "  prompt size  : ~${words} words (~${in_tokens} input tokens) sent to EACH of $n panelists"
echo "  note         : each panelist also generates a full answer, and the judge reads all $n;"
echo "                 real token cost is several× the input. Heavy deep-research questions are slow."
echo "  per-panelist timeout : ${UNIFUSION_TIMEOUT:-300}s (override with UNIFUSION_TIMEOUT)"

reminder() {
  local cli="$1" label="$2"
  if command -v "$cli" >/dev/null 2>&1; then
    echo "  $label : installed"
  else
    echo "  $label : NOT installed — this panelist will be skipped (panel degrades gracefully)."
  fi
}
reminder codex "codex (GPT-5.5)     "
reminder agy   "agy   (Gemini 3.5Flash)"
reminder kimi  "kimi  (Kimi K2.7)   "
reminder devin "devin (GLM-5.2)     "

if [ -n "${GEMINI_API_KEY:-}${GOOGLE_API_KEY:-}" ]; then
  echo "  session context : a compact gemini-3.5-flash brief of this session is prepended to every"
  echo "                    panelist prompt (best-effort; skipped silently if it can't be built)."
else
  echo "  session context : no GEMINI/GOOGLE API key — context injection will be skipped."
fi

exit 0
