#!/usr/bin/env bash
# run_kimi.sh — run one Kimi K2.7 panelist (via the `kimi` CLI) on a prompt, with web + bash.
#
# Usage:
#   run_kimi.sh <prompt_file> <output_file>
#
# - <prompt_file> : path to a file containing the FULL panelist prompt (verbatim user task + brief)
# - <output_file> : where the panelist's final answer is written (clean, just the answer)
#
# Kimi notes:
# - Print mode (`-p`) is non-interactive and auto-runs read-only + bash tools. The interactive
#   approval flags `-y/--yolo` and `--auto` ERROR when combined with `-p`, so neither is passed;
#   print mode approves tool calls on its own. Web search and fetch are native (Moonshot services
#   configured in ~/.kimi-code/config.toml) and run in print mode without any extra flag.
# - `--output-format text` writes the final answer to stdout; the thinking stream and the
#   "resume this session" trailer go to stderr. The captured answer is wrapped: a leading "• " on
#   the first line plus a uniform 2-space hanging indent on every line; genuine list items use
#   "- ". The capture below removes the leading bullet, the 2-space indent, and any ANSI, which
#   leaves real Markdown (including "- " lists) intact.
# - Model alias `kimi-code/kimi-for-coding` is "K2.7 Code" (override with KIMI_MODEL).
# - The panelist runs against a throwaway copy of the current repo/workdir, so its file writes do
#   not touch your live checkout, while still letting it inspect the repo for codebase evidence.
# - macOS has no `timeout`; the run is wrapped in the perl helper from _unifusion_lib.sh
#   (UNIFUSION_TIMEOUT, default 300s). On timeout the runner exits 124 so the orchestrator drops Kimi
#   and degrades the panel gracefully.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

prompt_file="${1:?usage: run_kimi.sh <prompt_file> <output_file>}"
output_file="${2:?usage: run_kimi.sh <prompt_file> <output_file>}"
KIMI_MODEL="${KIMI_MODEL:-kimi-code/kimi-for-coding}"

case "$prompt_file" in
  /*) ;;
  *) prompt_file="$(pwd -P)/$prompt_file" ;;
esac
case "$output_file" in
  /*) ;;
  *) output_file="$(pwd -P)/$output_file" ;;
esac

if [ ! -s "$prompt_file" ]; then
  echo "[run_kimi.sh] prompt file is missing or empty: $prompt_file" >&2
  exit 2
fi
if ! have kimi; then
  echo "[run_kimi.sh] kimi CLI not installed — skip this panelist." >&2
  exit 127
fi
mkdir -p "$(dirname "$output_file")"
rm -f "$output_file"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-kimi.XXXXXX")"
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
    kimi -p "$(cat "$prompt_file")" --output-format text -m "$KIMI_MODEL" ) \
  > "$scratch/raw.out" 2> "$scratch/stream.log"
status=$?

# Clean capture: strip ANSI, remove the leading "• " wrapper bullet and the uniform 2-space
# hanging indent (per line), drop residual control bytes (keep tab + newline).
sed -e 's/\x1b\[[0-9;]*m//g' "$scratch/raw.out" \
  | perl -CSD -pe 's/^\x{2022} ?//; s/^  //' \
  | LC_ALL=C tr -d '\000-\010\013-\037\177' > "$output_file"

if [ $status -eq 124 ]; then
  echo "[run_kimi.sh] kimi timed out after ${UNIFUSION_TIMEOUT}s; tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 124
fi
if [ $status -ne 0 ] || [ ! -s "$output_file" ]; then
  echo "[run_kimi.sh] kimi exited $status (or empty output); tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 1
fi
echo "[run_kimi.sh] ok -> $output_file"
