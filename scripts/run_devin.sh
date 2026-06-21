#!/usr/bin/env bash
# run_devin.sh — run one GLM-5.2 panelist (via the `devin` CLI) on a prompt, with web + bash.
#
# Usage:
#   run_devin.sh <prompt_file> <output_file>
#
# - <prompt_file> : path to a file containing the FULL panelist prompt (verbatim user task + brief)
# - <output_file> : where the panelist's final answer is written (clean, just the answer)
#
# Devin notes:
# - `--print --prompt-file <f>` is the clean non-interactive mode; reading the prompt from a file
#   sidesteps argument-length and shell-quoting limits.
# - `--permission-mode dangerous` auto-approves every tool, so web search and bash both run.
#   Devin's web search is native and needs no extra flag.
# - The model is GLM-5.2: `~/.config/devin/config.json` already pins `agent.model = "glm-5-2"`,
#   so print mode inherits it. Override with DEVIN_MODEL to pass an explicit `--model`.
# - In print mode devin writes only its final answer to stdout; the user config's fablize hooks do
#   not emit to stdout, so no isolation config is needed. A defensive ANSI/control strip is still
#   applied to the capture.
# - The panelist runs against a throwaway copy of the current repo/workdir, so its file writes do
#   not touch your live checkout, while still letting it inspect the repo for codebase evidence.
# - macOS has no `timeout`; the run is wrapped in the perl helper from _unifusion_lib.sh
#   (UNIFUSION_TIMEOUT, default 300s). On timeout the runner exits 124 so the orchestrator drops
#   GLM-5.2 and degrades the panel gracefully.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

prompt_file="${1:?usage: run_devin.sh <prompt_file> <output_file>}"
output_file="${2:?usage: run_devin.sh <prompt_file> <output_file>}"
DEVIN_MODEL="${DEVIN_MODEL:-}"

case "$prompt_file" in
  /*) ;;
  *) prompt_file="$(pwd -P)/$prompt_file" ;;
esac
case "$output_file" in
  /*) ;;
  *) output_file="$(pwd -P)/$output_file" ;;
esac

if [ ! -s "$prompt_file" ]; then
  echo "[run_devin.sh] prompt file is missing or empty: $prompt_file" >&2
  exit 2
fi
if ! have devin; then
  echo "[run_devin.sh] devin CLI not installed — skip this panelist." >&2
  exit 127
fi
mkdir -p "$(dirname "$output_file")"
rm -f "$output_file"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-devin.XXXXXX")"
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

devin_args=( --print --prompt-file "$prompt_file" --permission-mode dangerous )
if [ -n "$DEVIN_MODEL" ]; then
  devin_args+=( --model "$DEVIN_MODEL" )
fi

( cd "$panel_cwd" && _run_with_timeout "$UNIFUSION_TIMEOUT" devin "${devin_args[@]}" ) \
  > "$scratch/raw.out" 2> "$scratch/stream.log"
status=$?

# Clean capture: strip ANSI, drop residual control bytes (keep tab + newline).
sed -e 's/\x1b\[[0-9;]*m//g' "$scratch/raw.out" \
  | LC_ALL=C tr -d '\000-\010\013-\037\177' > "$output_file"

if [ $status -eq 124 ]; then
  echo "[run_devin.sh] devin timed out after ${UNIFUSION_TIMEOUT}s; tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 124
fi
if [ $status -ne 0 ] || [ ! -s "$output_file" ]; then
  echo "[run_devin.sh] devin exited $status (or empty output); tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 1
fi
echo "[run_devin.sh] ok -> $output_file"
