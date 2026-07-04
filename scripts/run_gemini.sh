#!/usr/bin/env bash
# run_gemini.sh — run one Gemini 3.5 Flash panelist (via the standalone `gemini` / Gemini CLI), web + bash.
#
# Usage:
#   run_gemini.sh <prompt_file> <output_file>
#
# Unlike the `agy` / Antigravity runner (preserved as run_agy.sh), the Gemini CLI writes a clean final
# answer to stdout in print mode (`-p`), so no pseudo-TTY shim or transcript-JSONL fallback is needed —
# a direct capture works.
#
# Panel isolation + headless fixes: the run uses an isolated $HOME/.gemini (built by
# _unifusion_write_gemini_panel_settings) so it never inherits the user's MCP/skills/extensions — Exa is
# the one server kept. That isolated settings.json also neutralises three headless stderr artifacts:
#   - experimental.contextManagement=false  -> no `models/context-calibrator` 404 (that pseudo-model only
#     exists on Vertex/Code-Assist auth, not the api-key generativelanguage endpoint).
#   - context.discoveryMaxDirs=0            -> no project-context scan of unreadable /tmp tmp-mount-* dirs.
#   - TERM=xterm-256color (set on the invocation) -> no "Basic terminal detected (TERM=dumb)" warning.
# All three were cosmetic stderr only (never in the answer), but silencing them keeps the log clean.
#
# Config (env):
#   GEMINI_MODEL            model id (default "gemini-3.5-flash"; the CLI uses API ids, not agy's
#                           "Gemini 3.5 Flash (Medium)" display name — see `gemini --help`).
#   GEMINI_THINKING_LEVEL   reasoning effort for Gemini 3.x Flash: MINIMAL | LOW | HIGH (default HIGH).
#   GEMINI_API_KEY / GOOGLE_API_KEY   required (the isolated home forces gemini-api-key auth).
#   UNIFUSION_TIMEOUT       per-panelist budget in seconds (default 600, from _unifusion_lib.sh).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

prompt_file="${1:?usage: run_gemini.sh <prompt_file> <output_file>}"
output_file="${2:?usage: run_gemini.sh <prompt_file> <output_file>}"

case "$prompt_file" in
  /*) ;;
  *) prompt_file="$(pwd -P)/$prompt_file" ;;
esac
case "$output_file" in
  /*) ;;
  *) output_file="$(pwd -P)/$output_file" ;;
esac

GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash}"
GEMINI_THINKING_LEVEL="${GEMINI_THINKING_LEVEL:-HIGH}"
EXT_TIMEOUT=$((UNIFUSION_TIMEOUT + 30))

if ! have gemini; then
  echo "[run_gemini.sh] gemini CLI not installed — skip this panelist." >&2
  exit 127
fi
if [ -z "${GEMINI_API_KEY:-}${GOOGLE_API_KEY:-}" ]; then
  echo "[run_gemini.sh] no GEMINI_API_KEY / GOOGLE_API_KEY — isolated home needs api-key auth. Skipping." >&2
  exit 127
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-gemini.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Isolated $HOME/.gemini: Exa-only MCP, no user skills/extensions, plus the headless fixes above.
gemini_home="$scratch/geminihome"
_unifusion_write_gemini_panel_settings "$gemini_home" "$GEMINI_MODEL" "$GEMINI_THINKING_LEVEL" || exit 1

# Run against a throwaway copy of the repo/workdir (like the other runners), so gemini's file writes
# never touch the live checkout. The copy lives under $scratch and is removed by the EXIT trap.
workdir="$scratch/workdir"
source_root="$(pwd -P)"
source_subdir=""
if git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  source_root="$(cd "$git_root" && pwd -P)"
  current_dir="$(pwd -P)"
  case "$current_dir" in
    "$source_root") source_subdir="" ;;
    "$source_root"/*) source_subdir="${current_dir#"$source_root"/}" ;;
    *) source_subdir="" ;;
  esac
fi
mkdir -p "$workdir"
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude '.git/index.lock' \
    --exclude '.git/shallow.lock' \
    --exclude '.git/worktrees/*/index.lock' \
    "$source_root"/ "$workdir"/
else
  cp -R "$source_root"/. "$workdir"/
fi
panel_cwd="$workdir"
if [ -n "$source_subdir" ]; then
  panel_cwd="$workdir/$source_subdir"
fi

# Assemble gemini args.
gemini_args=( -p "$(cat "$prompt_file")" -o text --yolo --skip-trust --allowed-mcp-server-names exa )
if [ -n "$GEMINI_MODEL" ]; then
  gemini_args+=( -m "$GEMINI_MODEL" )
fi

# --- Capture the clean stdout answer --------------------------------------------------
# HOME points gemini at the isolated config; TERM silences the dumb-terminal warning.
# sed strips ANSI (ESC[...m); tr removes residual control bytes (CR, etc.) while keeping tab + newline.
( cd "$panel_cwd" \
    && HOME="$gemini_home" TERM=xterm-256color \
       GEMINI_API_KEY="${GEMINI_API_KEY:-}" GOOGLE_API_KEY="${GOOGLE_API_KEY:-}" \
       _run_with_timeout "$EXT_TIMEOUT" gemini "${gemini_args[@]}" ) \
  2> "$scratch/stderr.log" \
  | sed -e 's/\x1b\[[0-9;]*m//g' \
  | LC_ALL=C tr -d '\000-\010\013-\037\177' > "$output_file"

# --- Anti-empty guard -----------------------------------------------------------------
if ! _has_content "$output_file"; then
  echo "[run_gemini.sh] gemini produced no answer. Dropping Gemini." >&2
  [ -s "$scratch/stderr.log" ] && { echo "[run_gemini.sh] gemini stderr tail:" >&2; tail -10 "$scratch/stderr.log" >&2; }
  exit 1
fi
echo "[run_gemini.sh] ok -> $output_file"
