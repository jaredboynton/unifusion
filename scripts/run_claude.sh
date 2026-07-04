#!/usr/bin/env bash
# run_claude.sh — run one Opus 4.8 panelist (via native `claude` CLI) on a prompt, with web + bash.
#
# Usage:
#   run_claude.sh <prompt_file> <output_file>
#
# - <prompt_file> : path to a file containing the FULL panelist prompt (verbatim user task + brief)
# - <output_file> : where the panelist's final answer is written (clean, just the answer)
#
# claude notes:
# - `claude` is the native Claude Code CLI (code.claude.com/docs/en/cli-reference).
# - `-p/--print` is the non-interactive headless mode; the prompt is fed on stdin (sidesteps
#   argument-length and shell-quoting limits). `--output-format text` writes only the final answer
#   to stdout.
# - `--model opus` pins Opus; override with UNIFUSION_OPUS_MODEL.
# - Clean-room: isolated CLAUDE_CONFIG_DIR with live standard user hooks (from
#   ~/.claude/settings.json), no plugins, fastMode on, plus `--mcp-config` with Exa only
#   (`--strict-mcp-config`). Exa is the one MCP server panelists get.
# - The panelist runs against a throwaway copy of the current repo/workdir, so its file writes do
#   not touch your live checkout, while still letting it inspect the repo for codebase evidence.
# - macOS has no `timeout`; the run is wrapped in the perl helper from _unifusion_lib.sh
#   (UNIFUSION_TIMEOUT, default 600s). On timeout the runner exits 124 so the orchestrator drops
#   this Opus panelist and degrades the panel gracefully. Any other non-zero exit or empty output => exit 1 (dropped).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

prompt_file="${1:?usage: run_claude.sh <prompt_file> <output_file>}"
output_file="${2:?usage: run_claude.sh <prompt_file> <output_file>}"
OPUS_MODEL="${UNIFUSION_OPUS_MODEL:-opus}"

case "$prompt_file" in
  /*) ;;
  *) prompt_file="$(pwd -P)/$prompt_file" ;;
esac
case "$output_file" in
  /*) ;;
  *) output_file="$(pwd -P)/$output_file" ;;
esac

if [ ! -s "$prompt_file" ]; then
  echo "[run_claude.sh] prompt file is missing or empty: $prompt_file" >&2
  exit 2
fi
if ! have claude; then
  echo "[run_claude.sh] claude command not found — skip this panelist." >&2
  exit 127
fi
mkdir -p "$(dirname "$output_file")"
rm -f "$output_file"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-claude.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
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

claude_home="$scratch/claudehome"
mkdir -p "$claude_home"
_unifusion_write_claude_panel_settings "$claude_home/settings.json" || exit 1
exa_mcp="$scratch/exa.mcp.json"
_unifusion_write_claude_exa_mcp "$exa_mcp"

# Auth: the native claude panelist signs in with a Claude.ai OAuth token from the
# environment (set CLAUDE_CODE_OAUTH_TOKEN, e.g. in your shell rc). The isolated
# CLAUDE_CONFIG_DIR has no logged-in session, so without this the panelist exits
# with "Not logged in". Bedrock toggles are neutralized so the OAuth path is used.
# Fall back to the macOS keychain when the env var is absent (e.g. cron / CI that
# does not source ~/.zshrc): security item service 'unifusion-claude-oauth'.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && command -v security >/dev/null 2>&1; then
  CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -a "$USER" -s unifusion-claude-oauth -w 2>/dev/null || true)"
  export CLAUDE_CODE_OAUTH_TOKEN
fi
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "[run_claude.sh] CLAUDE_CODE_OAUTH_TOKEN is not set (env or keychain service 'unifusion-claude-oauth') — the claude panelist would not be logged in. Export it (e.g. in ~/.zshrc)." >&2
  exit 1
fi

( cd "$panel_cwd"
  export CLAUDE_CONFIG_DIR="$claude_home"
  unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_MANTLE ANTHROPIC_API_KEY AWS_BEARER_TOKEN_BEDROCK
  _run_with_timeout "$UNIFUSION_TIMEOUT" \
    claude -p --model "$OPUS_MODEL" --output-format text \
    --mcp-config "$exa_mcp" --strict-mcp-config < "$prompt_file"
) > "$scratch/raw.out" 2> "$scratch/stream.log"
status=$?

# Clean capture: strip ANSI, drop residual control bytes (keep tab + newline).
sed -e 's/\x1b\[[0-9;]*m//g' "$scratch/raw.out" \
  | LC_ALL=C tr -d '\000-\010\013-\037\177' > "$output_file"

if [ $status -eq 124 ]; then
  echo "[run_claude.sh] claude timed out after ${UNIFUSION_TIMEOUT}s; tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 124
fi
if [ $status -ne 0 ] || ! _has_content "$output_file"; then
  echo "[run_claude.sh] claude exited $status (or empty/whitespace-only output); tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  # Preserve the stream log next to the output so the orchestrator run dir keeps a
  # diagnostic after the scratch dir is removed on EXIT.
  cp "$scratch/stream.log" "${output_file}.stream.log" 2>/dev/null || true
  exit 1
fi
echo "[run_claude.sh] ok -> $output_file"
