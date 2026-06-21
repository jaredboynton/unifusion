#!/usr/bin/env bash
# summarize_session.sh — build a compact, FACTUAL session-context brief for Unifusion panelists.
#
# Usage:
#   summarize_session.sh <output_file>
#
# Resolves the current session transcript (resolve_session.sh, host-agnostic) and summarizes it with
# compact-full-transcript.mjs (schema-constrained structured output). Forward-looking sections (planned
# next steps, promises) are stripped so the shared brief stays factual-state-only — the one shared prior
# the panel is allowed, which depends on it never proposing an approach or hinting the answer. The brief
# is written to <output_file>; the orchestrator prepends the identical brief to every panelist prompt.
#
# Best-effort: when context can't be built the script writes nothing useful and exits non-zero so
# the orchestrator simply skips injection and fans out on the verbatim task.
#
# Exit codes:
#   0  ok — brief written to <output_file>
#   3  no session transcript found
#   4  no API key for the chosen provider
#   6  summarizer failed (node missing, model/API error, empty brief)
#
# Env:
#   CLAUDE_CODE_SESSION_ID / CLAUDE_CONFIG_DIR   locate the transcript (set by Claude Code)
#   UNIFUSION_CONTEXT_PROVIDER   summarizer provider (default gemini; also codex/xai/mantle)
#   GEMINI_API_KEY / GOOGLE_API_KEY   required for the default gemini provider
#   plus the COMPACT_*/GEMINI_* knobs read by compact-full-transcript.mjs

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_file="${1:?usage: summarize_session.sh <output_file>}"
have() { command -v "$1" >/dev/null 2>&1; }
PROVIDER="${UNIFUSION_CONTEXT_PROVIDER:-gemini}"

if ! have node; then
  echo "[summarize] node not installed — skip context injection." >&2
  exit 6
fi
if [ "$PROVIDER" = "gemini" ] && [ -z "${GEMINI_API_KEY:-}${GOOGLE_API_KEY:-}" ]; then
  echo "[summarize] no GEMINI_API_KEY / GOOGLE_API_KEY — skip context injection." >&2
  exit 4
fi

case "$output_file" in
  /*) ;;
  *) output_file="$(pwd -P)/$output_file" ;;
esac
mkdir -p "$(dirname "$output_file")"
rm -f "$output_file"

read -r -d '' instructions <<'EOF'
Produce a FACTUAL STATE-ONLY brief that orients an independent expert about to answer the user's most
recent request. Include only: the user's overarching goal; decisions, rules, and constraints the user
stated; important files, paths, commands, identifiers, and values in play; and the current state of
the work. Do NOT include planned next steps, proposed approaches, recommendations, opinions, or
assistant commitments, and do not answer or hint at the answer to any question.
EOF

# Transcript source: explicit UNIFUSION_TRANSCRIPT wins; otherwise resolve THIS session's transcript
# host-agnostically (Claude/Codex/Droid/Devin), fingerprint-disambiguated against the verbatim
# question. Fail closed if neither yields a readable file.
if [ -n "${UNIFUSION_TRANSCRIPT:-}" ] && [ -s "${UNIFUSION_TRANSCRIPT:-}" ]; then
  transcript="$UNIFUSION_TRANSCRIPT"
else
  transcript="$(bash "$SCRIPT_DIR/resolve_session.sh" --path --fingerprint-file /tmp/unifusion_question.txt 2>/dev/null)"
fi
if [ -z "$transcript" ] || [ ! -s "$transcript" ]; then
  echo "[summarize] could not resolve the current session transcript — skip context injection." >&2
  exit 3
fi

outdir="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-ctx.XXXXXX")"
errlog="$(mktemp "${TMPDIR:-/tmp}/unifusion-summarize.XXXXXX")"

# Schema-constrained structured output on the resolved transcript.
# CODEX_CLIENT_VERSION / CODEX_USER_AGENT are pre-set so the engine's module-load shell-outs
# (codex --version, sw_vers) are skipped — the summarizer never depends on the codex CLI.
CODEX_CLIENT_VERSION="${CODEX_CLIENT_VERSION:-0.0.0}" \
CODEX_USER_AGENT="${CODEX_USER_AGENT:-unifusion-summarizer}" \
node "$SCRIPT_DIR/compact-full-transcript.mjs" \
  --provider "$PROVIDER" \
  --transcript "$transcript" \
  --out-dir "$outdir" \
  --no-live-output \
  --summary-instructions "$instructions" \
  >/dev/null 2>"$errlog"
rc=$?

if [ "$rc" -eq 3 ]; then
  echo "[summarize] no session transcript found (session=${CLAUDE_CODE_SESSION_ID:-unset}) — skip context injection." >&2
  tail -3 "$errlog" >&2; rm -rf "$outdir" "$errlog"; exit 3
fi
if [ "$rc" -ne 0 ] || [ ! -s "$outdir/summary.md" ]; then
  echo "[summarize] summarizer failed:" >&2
  tail -6 "$errlog" >&2; rm -rf "$outdir" "$errlog"; exit 6
fi

# Strip forward-looking sections so the shared brief stays factual-state-only (panel independence).
awk '
  /^## / { drop = ($0 ~ /^## (Plans And Task State|Promises Made|Optional Next Step|Next Step)[[:space:]]*$/) ? 1 : 0 }
  !drop { print }
' "$outdir/summary.md" > "$output_file"

rm -rf "$outdir" "$errlog"

if [ ! -s "$output_file" ]; then
  echo "[summarize] empty brief — skip context injection." >&2
  exit 6
fi
echo "[summarize] ok -> $output_file" >&2
