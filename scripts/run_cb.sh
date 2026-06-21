#!/usr/bin/env bash
# run_cb.sh — run one Opus 4.8 panelist (via `cb`: Claude in Bedrock mode) on a prompt, with web + bash.
#
# Usage:
#   run_cb.sh <prompt_file> <output_file>
#
# - <prompt_file> : path to a file containing the FULL panelist prompt (verbatim user task + brief)
# - <output_file> : where the panelist's final answer is written (clean, just the answer)
#
# cb notes:
# - `cb` (~/bin/cb) is `claude-launch cb bedrock`, which routes Claude Code through AWS Bedrock
#   (default model global.anthropic.claude-opus-4-8) and execs the real claude binary with
#   `--dangerously-skip-permissions` already appended, so the panelist auto-approves its tools.
# - `-p/--print` is the non-interactive headless mode; the prompt is fed on stdin (sidesteps
#   argument-length and shell-quoting limits). `--output-format text` writes only the final answer
#   to stdout.
# - `--model opus` pins Opus; override with UNIFUSION_OPUS_MODEL.
# - `--safe-mode` disables plugins, MCP, hooks, and skills for this run.
# - The panelist runs against a throwaway copy of the current repo/workdir, so its file writes do
#   not touch your live checkout, while still letting it inspect the repo for codebase evidence.
# - macOS has no `timeout`; the run is wrapped in the perl helper from _unifusion_lib.sh
#   (UNIFUSION_TIMEOUT, default 300s). On timeout the runner exits 124 so the orchestrator drops
#   this Opus panelist and degrades the panel gracefully. Any other non-zero exit (e.g. cb exits 78
#   when the Bedrock bearer token is missing) or empty output => exit 1 (dropped).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

prompt_file="${1:?usage: run_cb.sh <prompt_file> <output_file>}"
output_file="${2:?usage: run_cb.sh <prompt_file> <output_file>}"
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
  echo "[run_cb.sh] prompt file is missing or empty: $prompt_file" >&2
  exit 2
fi
if ! have cb; then
  echo "[run_cb.sh] cb command not found — skip this panelist." >&2
  exit 127
fi
mkdir -p "$(dirname "$output_file")"
rm -f "$output_file"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-cb.XXXXXX")"
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

( cd "$panel_cwd" && _run_with_timeout "$UNIFUSION_TIMEOUT" \
    cb -p --model "$OPUS_MODEL" --safe-mode --output-format text < "$prompt_file" ) \
  > "$scratch/raw.out" 2> "$scratch/stream.log"
status=$?

# Clean capture: strip ANSI, drop residual control bytes (keep tab + newline).
sed -e 's/\x1b\[[0-9;]*m//g' "$scratch/raw.out" \
  | LC_ALL=C tr -d '\000-\010\013-\037\177' > "$output_file"

if [ $status -eq 124 ]; then
  echo "[run_cb.sh] cb timed out after ${UNIFUSION_TIMEOUT}s; tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 124
fi
if [ $status -ne 0 ] || [ ! -s "$output_file" ]; then
  echo "[run_cb.sh] cb exited $status (or empty output); tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 1
fi
echo "[run_cb.sh] ok -> $output_file"
