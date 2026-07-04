#!/usr/bin/env bash
# resolve_session.sh - identify the agent session THIS process is running inside, across host
# CLIs (Claude Code, Codex, Droid, Devin), with zero arguments, and print its transcript path.
#
#   (default)               print the bare session id
#   --path                  print the transcript file path
#   --id                    print the session id (explicit)
#   --json                  print {"host","sessionId","jsonlPath","method"}
#   --fingerprint <str>     a distinctive line known to appear in the current session transcript
#   --fingerprint-file <f>  ...or read the fingerprint from a file (e.g. /tmp/unifusion_question.txt)
#
# Exit codes: 0 resolved | 2 usage | 3 no host detected | 4 no transcript resolved
#
# How it works: walk this process's ancestry to the host agent (by comm/argv), read the session id
# from the host's env or argv, and map id -> transcript path per host. A fingerprint (a line the
# current session is known to contain) disambiguates when several candidates share a cwd and verifies
# a resolved path. Resolution is deterministic or fingerprint-verified; if it cannot be resolved, it
# exits non-zero (fail closed).

set -u

want="id"; fp=""; fpfile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --path) want="path" ;;
    --id) want="id" ;;
    --json) want="json" ;;
    --fingerprint) fp="${2:-}"; shift ;;
    --fingerprint-file) fpfile="${2:-}"; shift ;;
    *) echo "usage: resolve_session.sh [--path|--id|--json] [--fingerprint <s>|--fingerprint-file <f>]" >&2; exit 2 ;;
  esac
  shift
done

uuid_re='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

# --- fingerprint: a distinctive single line, trimmed before any double-quote (JSON-escape safe) ----
if [ -z "$fp" ] && [ -n "$fpfile" ] && [ -f "$fpfile" ]; then
  fp="$(awk '{ l=$0; q=index(l,"\""); if(q>1) l=substr(l,1,q-1);
              sub(/[[:space:]]+$/,"",l); if(length(l)>=24){print l; exit} }' "$fpfile")"
fi
fp_has() { [ -z "$fp" ] && return 0; [ -f "$1" ] && grep -qF -- "$fp" "$1"; }
# fp_select FILES... : echo the single file containing the fingerprint; return 1 on 0 or >1 matches.
fp_select() {
  [ -z "$fp" ] && return 1
  local f n=0 hit=""
  for f in "$@"; do
    [ -f "$f" ] || continue
    if grep -qF -- "$fp" "$f" 2>/dev/null; then hit="$f"; n=$((n + 1)); fi
  done
  [ "$n" -eq 1 ] && { printf '%s' "$hit"; return 0; }
  return 1
}

# --- detect the nearest agent ancestor (host) + its pid/argv ---------------------------------------
host=""; agent_pid=""; agent_argv=""
pid=$$
for _ in $(seq 1 40); do
  read -r ppid comm < <(ps -o ppid=,comm= -p "$pid" 2>/dev/null)
  [ -z "${ppid:-}" ] && break
  argv="$(ps -o command= -p "$pid" 2>/dev/null)"
  h=""
  case "$comm" in
    *claude) h=claude ;; *codex) h=codex ;; *droid) h=droid ;;
    *devin) h=devin ;; *glm-acp-agent|*glm-acp) h=glm ;;
  esac
  if [ -z "$h" ]; then
    case "$argv" in
      *@openai/codex*) h=codex ;;
      */claude\ *|*/claude) h=claude ;;
      *@devin*|*devin\ *) h=devin ;;
    esac
  fi
  if [ -n "$h" ]; then host="$h"; agent_pid="$pid"; agent_argv="$argv"; break; fi
  { [ "$ppid" = "0" ] || [ "$ppid" = "1" ]; } && break
  pid="$ppid"
done

# env ids are authoritative and also imply the host even if ancestry was inconclusive
[ -z "$host" ] && [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && host=claude
[ -z "$host" ] && [ -n "${CODEX_THREAD_ID:-}" ] && host=codex
[ -z "$host" ] && { echo "no agent host detected in process ancestry" >&2; exit 3; }

# host cwd (independent of where this script was invoked)
hostcwd=""
[ -n "$agent_pid" ] && hostcwd="$(lsof -a -d cwd -p "$agent_pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
[ -z "$hostcwd" ] && hostcwd="${PWD:-$(pwd)}"

# --- per-host id + transcript path -----------------------------------------------------------------
id=""; path=""; method=""; candidates=()
case "$host" in
  claude)
    id="${CLAUDE_CODE_SESSION_ID:-}"
    [ -z "$id" ] && [[ "$agent_argv" =~ (--resume|--session-id|-r)[[:space:]=]+($uuid_re) ]] && id="${BASH_REMATCH[2]}"
    [ -n "$id" ] && method="env/argv"
    cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    [ -n "$id" ] && path="$(/usr/bin/find "$cfg/projects" -maxdepth 2 -name "$id.jsonl" -type f 2>/dev/null | head -1)"
    shopt -s nullglob; candidates=("$cfg/projects/${hostcwd//\//-}"/*.jsonl); shopt -u nullglob
    ;;
  codex)
    id="${CODEX_THREAD_ID:-}"
    [ -z "$id" ] && [[ "$agent_argv" =~ ($uuid_re) ]] && id="${BASH_REMATCH[1]}"
    [ -n "$id" ] && method="env/argv"
    [ -n "$id" ] && path="$(/usr/bin/find "$HOME/.codex/sessions" -name "rollout-*-$id.jsonl" -type f 2>/dev/null | head -1)"
    shopt -s nullglob
    while IFS= read -r f; do candidates+=("$f"); done < <(/usr/bin/find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mtime -2 2>/dev/null)
    shopt -u nullglob
    ;;
  droid)
    [[ "$agent_argv" =~ (--resume|--session-id|--fork|-s|-r)[[:space:]=]+($uuid_re) ]] && id="${BASH_REMATCH[2]}"
    [ -n "$id" ] && method="argv"
    dir="$HOME/.factory/sessions/${hostcwd//\//-}"
    [ -n "$id" ] && [ -f "$dir/$id.jsonl" ] && path="$dir/$id.jsonl"
    shopt -s nullglob; candidates=("$dir"/*.jsonl); shopt -u nullglob
    ;;
  devin)
    tdir="$HOME/.local/share/devin/cli/transcripts"
    # `devin list` only reports sessions for the process cwd, so run it from the host's cwd.
    if command -v devin >/dev/null 2>&1; then
      id="$( (cd "$hostcwd" 2>/dev/null && devin list --format json 2>/dev/null) | /usr/bin/python3 -c '
import sys, json
cwd = sys.argv[1]
try: rows = json.load(sys.stdin)
except Exception: rows = []
rows = [r for r in rows if r.get("working_directory") == cwd]
rows.sort(key=lambda r: r.get("last_activity_at", 0), reverse=True)
print(rows[0]["id"] if rows else "")
' "$hostcwd" 2>/dev/null)"
    fi
    [ -n "$id" ] && method="devin-list"
    [ -n "$id" ] && [ -f "$tdir/$id.json" ] && path="$tdir/$id.json"
    shopt -s nullglob; candidates=("$tdir"/*.json); shopt -u nullglob
    ;;
  glm)
    gdir="${ACP_GLM_SESSION_DIR:-$HOME/.local/state/glm-acp-agent/sessions}"
    # glm-acp-agent persists sessions as JSON files keyed by sessionId, each containing
    # cwd + updatedAt metadata. No list command, so fingerprint is the only selector.
    shopt -s nullglob; candidates=("$gdir"/*.json); shopt -u nullglob
    ;;
esac

# --- fingerprint disambiguate (deterministic id, else unique fingerprint match, else fail closed) ---
# A deterministic env/argv/list id is trusted. If a fingerprint is given and the deterministic path does
# NOT contain it BUT a unique candidate does, prefer that candidate (corrects a stale id); otherwise keep
# the deterministic path (the fingerprint may simply not be flushed to the transcript yet).
if [ -n "${path:-}" ] && [ -n "$fp" ] && ! fp_has "$path"; then
  if sel="$(fp_select "${candidates[@]:-}")"; then path="$sel"; method="fingerprint"; fi
fi
# No deterministic path: the fingerprint is the only safe selector. Unique match or fail closed.
if [ -z "${path:-}" ]; then
  if sel="$(fp_select "${candidates[@]:-}")"; then path="$sel"; method="fingerprint"; fi
fi

[ -z "${path:-}" ] && { echo "could not resolve a transcript for host=$host (need a deterministic id or a matching fingerprint)" >&2; exit 4; }
[ -z "${id:-}" ] && { id="$(basename "$path")"; id="${id%.jsonl}"; id="${id%.json}"; }

case "$want" in
  id)   printf '%s\n' "$id" ;;
  path) printf '%s\n' "$path" ;;
  json) printf '{"host":"%s","sessionId":"%s","jsonlPath":"%s","method":"%s"}\n' "$host" "$id" "$path" "${method:-unknown}" ;;
esac
