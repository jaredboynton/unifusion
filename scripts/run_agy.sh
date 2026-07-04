#!/usr/bin/env bash
# run_agy.sh — run one Gemini 3.5 Flash panelist (via the `agy` / Antigravity CLI), web + bash.
#
# Usage:
#   run_agy.sh <prompt_file> <output_file>
#
# Why this is not a plain `agy -p ... > out`:
# agy bug #76 — in print mode (`-p`) with no TTY attached, agy exits 0 but writes an EMPTY
# stdout. So a naive capture silently yields nothing. This script neutralises that with two
# independent paths plus a hard anti-empty guard:
#
#   Path A (primary)  : run agy under a pseudo-TTY (`script -q /dev/null ...`) so print mode
#                       behaves as if interactive, strip ANSI/CR, capture stdout.
#   Path B (fallback) : if path A is empty, read the answer back from agy's own transcript
#                       JSONL (the last MODEL/DONE/PLANNER_RESPONSE record's .content).
#   Anti-empty guard  : if both are empty, print to stderr and exit 1 — NEVER exit 0 empty.
#                       The orchestrator then drops Gemini and degrades the panel.
#
# Config (env):
#   AGY_MODEL            model name (default "Gemini 3.5 Flash (Medium)"; see `agy models`).
#   UNIFUSION_AGY_NO_MODEL  set to 1 to omit --model and use agy's configured default
#                        (escape hatch if --model ever hangs in print mode).
#   UNIFUSION_TIMEOUT       per-panelist budget in seconds (default 600, from _unifusion_lib.sh).
# Exa MCP is read from ~/.gemini/config/mcp_config.json (serverUrl or url key).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_unifusion_lib.sh"

prompt_file="${1:?usage: run_agy.sh <prompt_file> <output_file>}"
output_file="${2:?usage: run_agy.sh <prompt_file> <output_file>}"

case "$prompt_file" in
  /*) ;;
  *) prompt_file="$(pwd -P)/$prompt_file" ;;
esac
case "$output_file" in
  /*) ;;
  *) output_file="$(pwd -P)/$output_file" ;;
esac

AGY_MODEL="${AGY_MODEL:-Gemini 3.5 Flash (Medium)}"
BRAIN_DIR="$HOME/.gemini/antigravity-cli/brain"
# agy's own print-mode deadline (Go duration); keep the external backstop a bit longer
# so agy stops itself cleanly first.
AGY_PRINT_TIMEOUT="${UNIFUSION_TIMEOUT}s"
EXT_TIMEOUT=$((UNIFUSION_TIMEOUT + 30))

if ! have agy; then
  echo "[run_agy.sh] agy CLI not installed — skip this panelist." >&2
  exit 127
fi
gemini_mcp="${HOME}/.gemini/config/mcp_config.json"
if [ ! -f "$gemini_mcp" ] || ! grep -q 'mcp\.exa\.ai' "$gemini_mcp" 2>/dev/null; then
  echo "[run_agy.sh] warning: exa MCP missing from ~/.gemini/config/mcp_config.json" >&2
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/unifusion-gemini.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
ts_marker="$scratch/.t"; : > "$ts_marker"   # everything agy writes after this is "newer"

# Run against a throwaway copy of the repo/workdir (like the other runners), so agy's file writes
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

# Assemble agy args (model is opt-out via UNIFUSION_AGY_NO_MODEL).
agy_args=( -p "$(cat "$prompt_file")" --dangerously-skip-permissions --print-timeout "$AGY_PRINT_TIMEOUT" )
if [ -z "${UNIFUSION_AGY_NO_MODEL:-}" ] && [ -n "$AGY_MODEL" ]; then
  agy_args+=( --model "$AGY_MODEL" )
fi

# --- Path A: pseudo-TTY (survives socket stdio in cmux / headless) ---------------------
# agy bug #76 needs a real TTY on stdout. `script -q /dev/null` calls tcgetattr() on fd 0 and
# ABORTS when the orchestrator runs in a socket (cmux/headless: "tcgetattr/ioctl: Operation not
# supported on socket"), so agy never launches and path A *and* path B come back empty. Prefer a
# pty.fork()-based Python runner that gives the CHILD a fresh pty and never touches the parent's
# fd 0 termios; fall back to `script` only if python3 is missing (plain TTY contexts).
# sed strips ANSI (ESC[...m) and the literal "^D" caret-notation; tr removes residual control
# bytes (CR, etc.) while keeping tab + newline.
if have python3; then
  pty_runner=( python3 "$SCRIPT_DIR/_pty_run.py" )
else
  pty_runner=( script -q /dev/null )
fi
( cd "$panel_cwd" && _run_with_timeout "$EXT_TIMEOUT" "${pty_runner[@]}" agy "${agy_args[@]}" ) \
  2> "$scratch/stderr.log" \
  | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/\^D//g' \
  | LC_ALL=C tr -d '\000-\010\013-\037\177' > "$output_file"

# --- Path B: transcript JSONL fallback ------------------------------------------------
if ! _has_content "$output_file"; then
  echo "[run_agy.sh] path A empty (bug #76 probable) — fallback transcript JSONL." >&2
  tr="$(find "$BRAIN_DIR" -name transcript.jsonl -newer "$ts_marker" -print0 2>/dev/null \
        | xargs -0 ls -t 2>/dev/null | head -1)"
  if [ -n "$tr" ] && [ -s "$tr" ]; then
    jq -rs 'map(select(.source=="MODEL" and .status=="DONE" and .type=="PLANNER_RESPONSE"))
            | (last // {}) | .content // empty' "$tr" > "$output_file" 2>/dev/null
  fi
fi

# --- Anti-empty guard -----------------------------------------------------------------
if ! _has_content "$output_file"; then
  echo "[run_agy.sh] agy produced no answer (path A + path B both empty). Dropping Gemini." >&2
  [ -s "$scratch/stderr.log" ] && { echo "[run_agy.sh] agy stderr tail:" >&2; tail -10 "$scratch/stderr.log" >&2; }
  exit 1
fi
echo "[run_agy.sh] ok -> $output_file"
