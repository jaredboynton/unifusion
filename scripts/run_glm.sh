#!/usr/bin/env bash
# run_glm.sh — run one GLM-5.2 panelist (via `glm-acp-agent` ACP) on a prompt, with web + bash.
#
# Usage:
#   run_glm.sh <prompt_file> <output_file>
#
# - <prompt_file> : path to a file containing the FULL panelist prompt (verbatim user task + brief)
# - <output_file> : where the panelist's final answer is written (clean, just the answer)
#
# GLM ACP agent notes:
# - `glm-acp-agent` is an ACP stdio agent (newline-delimited JSON-RPC), not a traditional CLI.
#   The Node shim `_acp_client.mjs` drives the full protocol: initialize -> authenticate ->
#   session/new -> session/set_mode -> session/prompt -> session/close.
# - MCP servers (Exa only) are passed via `session/new` params, not a config file.
# - Permission bypass is via `session/set_mode` with `bypass_permissions`
#   (equivalent to devin's `--permission-mode dangerous`).
# - Model is GLM-5.2 (override with GLM_MODEL). Max output tokens default to the Z.AI API ceiling
#   for glm-5.2 (131072; override with GLM_MAX_TOKENS). The agent's built-in web_search and
#   web_reader tools are always available (Z.AI Coding Plan MCP), so web research works without
#   extra config.
# - Thinking mode is ON by default (ACP_GLM_THINKING=true) so the panelist reasons before
#   answering; override with ACP_GLM_THINKING=false. glm-acp-agent exposes only on/off thinking,
#   not a low/medium/high effort scale.
# - The panelist runs against a throwaway copy of the current repo/workdir, so its file writes do
#   not touch your live checkout, while still letting it inspect the repo for codebase evidence.
# - macOS has no `timeout`; the run is wrapped in the perl helper from _unifusion_lib.sh
#   (UNIFUSION_TIMEOUT, default 600s). On timeout the runner exits 124 so the orchestrator drops
#   GLM-5.2 and degrades the panel gracefully.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

prompt_file="${1:?usage: run_glm.sh <prompt_file> <output_file>}"
output_file="${2:?usage: run_glm.sh <prompt_file> <output_file>}"
GLM_MODEL="${GLM_MODEL:-glm-5.2}"
GLM_MAX_TOKENS="${GLM_MAX_TOKENS:-131072}"
export ACP_GLM_THINKING="${ACP_GLM_THINKING:-true}"

case "$prompt_file" in
  /*) ;;
  *) prompt_file="$(pwd -P)/$prompt_file" ;;
esac
case "$output_file" in
  /*) ;;
  *) output_file="$(pwd -P)/$output_file" ;;
esac

if [ ! -s "$prompt_file" ]; then
  echo "[run_glm.sh] prompt file is missing or empty: $prompt_file" >&2
  exit 2
fi
if ! have glm-acp-agent; then
  echo "[run_glm.sh] glm-acp-agent CLI not installed — skip this panelist." >&2
  exit 127
fi
if ! have node; then
  echo "[run_glm.sh] node not found (needed for ACP client shim) — skip this panelist." >&2
  exit 127
fi
mkdir -p "$(dirname "$output_file")"
rm -f "$output_file"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-glm.XXXXXX")"
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

glm_args=(
  --agent glm-acp-agent
  --prompt-file "$prompt_file"
  --cwd "$panel_cwd"
  --model "$GLM_MODEL"
  --max-tokens "$GLM_MAX_TOKENS"
)
[ -n "${UNIFUSION_EXA_MCP_URL:-}" ] && glm_args+=( --mcp-url "$UNIFUSION_EXA_MCP_URL" )

( _run_with_timeout "$UNIFUSION_TIMEOUT" node "$SCRIPT_DIR/_acp_client.mjs" "${glm_args[@]}" ) \
  > "$scratch/raw.out" 2> "$scratch/stream.log"
status=$?

# Clean capture: strip ANSI, drop residual control bytes (keep tab + newline).
# ACP text chunks are clean JSON so this is mostly a safety net.
sed -e 's/\x1b\[[0-9;]*m//g' "$scratch/raw.out" \
  | LC_ALL=C tr -d '\000-\010\013-\037\177' > "$output_file"

if [ $status -eq 124 ]; then
  echo "[run_glm.sh] glm-acp-agent timed out after ${UNIFUSION_TIMEOUT}s; tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  exit 124
fi
if [ $status -ne 0 ] || ! _has_content "$output_file"; then
  echo "[run_glm.sh] glm-acp-agent exited $status (or empty/whitespace-only output); tail of log:" >&2
  tail -20 "$scratch/stream.log" >&2
  cp "$scratch/stream.log" "${output_file}.stream.log" 2>/dev/null || true
  exit 1
fi
echo "[run_glm.sh] ok -> $output_file"
