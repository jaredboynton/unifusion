#!/usr/bin/env bash
# run_codex.sh — run one GPT-5.5 panelist (via codex) on a prompt, with web search + bash.
#
# Usage:
#   run_codex.sh <prompt_file> <output_file> [reasoning_effort]
#
# - <prompt_file>   : path to a file containing the FULL panelist prompt (verbatim user task + brief instruction)
# - <output_file>   : where the panelist's final answer is written (clean, just the answer)
# - reasoning_effort: low | medium | high | xhigh   (default: xhigh)
#
# Notes:
# - `-o/--output-last-message` writes ONLY the agent's final message — no streaming noise to parse.
# - The panelist runs against a temporary copy of the current repo/workdir, so its file writes do not
#   touch your live checkout.
# - `--dangerously-bypass-approvals-and-sandbox` intentionally gives the panelist the same local tool
#   access as a normal trusted Codex CLI run. This is needed for macOS keychain-backed tools like `gh`.
# - `-c tools.web_search=true` enables the web search tool.
# - Runs under an isolated CODEX_HOME: live ~/.codex/hooks.json, fast service tier,
#   hooks+code_mode enabled, Exa MCP only; hook trust bypassed for headless runs.
# - The throwaway copy is deleted when the panelist exits.
# - There is no `timeout`/`gtimeout` on stock macOS, so the codex run is wrapped in a self-contained
#   perl timeout helper (UNIFUSION_TIMEOUT, default 600s — see _unifusion_lib.sh). On timeout the runner
#   exits 124 so the orchestrator drops GPT-5.5 and degrades the panel gracefully.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

prompt_file="${1:?usage: run_codex.sh <prompt_file> <output_file> [reasoning_effort]}"
output_file="${2:?usage: run_codex.sh <prompt_file> <output_file> [reasoning_effort]}"
effort="${3:-xhigh}"

case "$prompt_file" in
  /*) ;;
  *) prompt_file="$(pwd -P)/$prompt_file" ;;
esac
case "$output_file" in
  /*) ;;
  *) output_file="$(pwd -P)/$output_file" ;;
esac

if [ ! -s "$prompt_file" ]; then
  echo "[run_codex.sh] prompt file is missing or empty: $prompt_file" >&2
  exit 2
fi
mkdir -p "$(dirname "$output_file")"
rm -f "$output_file"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-codex.XXXXXX")"
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

if command -v gh >/dev/null 2>&1; then
  if gh auth status --active --hostname github.com >/dev/null 2>&1; then
    echo "[run_codex.sh] gh auth ok in parent environment" >&2
  else
    echo "[run_codex.sh] warning: gh auth is not usable in parent environment" >&2
  fi
fi

codex_home="$scratch/codexhome"
codex_model="${UNIFUSION_CODEX_MODEL:-gpt-5.5}"
_unifusion_write_codex_panel_config "$codex_home" "$codex_model" "$effort" || exit 1

CODEX_HOME="$codex_home" _run_with_timeout "$UNIFUSION_TIMEOUT" codex exec \
  --skip-git-repo-check \
  --ephemeral \
  --cd "$panel_cwd" \
  --dangerously-bypass-approvals-and-sandbox \
  --dangerously-bypass-hook-trust \
  -c tools.web_search=true \
  -o "$output_file" \
  - < "$prompt_file" \
  > "$scratch/stream.log" 2>&1

status=$?
if [ $status -eq 124 ]; then
  echo "[run_codex.sh] codex timed out after ${UNIFUSION_TIMEOUT}s; tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 124
fi
if [ $status -ne 0 ] || ! _has_content "$output_file"; then
  echo "[run_codex.sh] codex exited $status (or empty/whitespace-only output); tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  cp "$scratch/stream.log" "${output_file}.stream.log" 2>/dev/null || true
  exit 1
fi
echo "[run_codex.sh] ok -> $output_file"
