#!/usr/bin/env bash
# _unifusion_lib.sh — shared helpers for the Unifusion panelist runners.
#
# Sourced (not executed) by run_codex.sh and run_gemini.sh:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/_unifusion_lib.sh"
#
# Why this exists: macOS has no `timeout`/`gtimeout` (those ship with GNU coreutils,
# not installed here). _run_with_timeout reproduces GNU `timeout` semantics with a
# small self-contained perl fork+alarm wrapper: it sends SIGTERM on the deadline,
# then SIGKILL after a 2s grace, returns the command's real exit status, and returns
# 124 when the command was killed for running over time.

# Default per-panelist budget in seconds; override with UNIFUSION_TIMEOUT.
# 600s, not 300s: when all five heavy agent CLIs run concurrently they contend for
# CPU, and the slowest-reasoning panelists (Opus via claude, GPT-5.5 xhigh via codex)
# stretch well past their isolated runtime. At 300s claude measured ~117s solo but
# exceeded 300s under full 5-way contention and was killed (exit 124, dropped:timeout);
# 600s gives both heavy models headroom to finish while still bounding a hung run.
UNIFUSION_TIMEOUT="${UNIFUSION_TIMEOUT:-600}"

# Exa MCP endpoint injected into panelist configs (claude/codex/devin throwaways).
# Override with UNIFUSION_EXA_MCP_URL when rotating keys.
UNIFUSION_EXA_MCP_URL="${UNIFUSION_EXA_MCP_URL:-https://mcp.exa.ai/mcp?exaApiKey=93b180fe-b949-451c-afd0-47c6bcca335f}"

have() { command -v "$1" >/dev/null 2>&1; }

# _has_content <file> — true when the file exists and holds at least one
# non-whitespace byte. `test -s` only checks size > 0, so a panelist that emits a
# lone newline (observed from claude under load: exit 0 but a 1-byte "\n"
# answer) would otherwise pass as a real answer and feed the judge an empty
# panelist. Runners use this instead of `-s` for their final success check.
_has_content() {
  local f="${1:-}"
  [ -f "$f" ] || return 1
  LC_ALL=C grep -q '[^[:space:]]' "$f" 2>/dev/null
}

# _unifusion_write_claude_exa_mcp <json_path> — Claude `--mcp-config` file (exa only).
_unifusion_write_claude_exa_mcp() {
  local path="${1:?path required}"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "{\"mcpServers\":{\"exa\":{\"type\":\"http\",\"url\":\"${UNIFUSION_EXA_MCP_URL}\"}}}" > "$path"
}

# _unifusion_write_claude_panel_settings <dest.json>
# Panel isolation for claude: live user hooks, no plugins, Exa via --mcp-config, fastMode on.
_unifusion_write_claude_panel_settings() {
  local dest="${1:?dest required}"
  python3 - "$dest" <<'PY' || return 1
import json, os, sys
dest = sys.argv[1]
src = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
try:
    with open(src, encoding="utf-8") as f:
        user = json.load(f)
except OSError as e:
    print(f"[_unifusion_lib] cannot read {src}: {e}", file=sys.stderr)
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"[_unifusion_lib] invalid JSON in {src}: {e}", file=sys.stderr)
    sys.exit(1)
panel = {
    "hooks": user.get("hooks", {}),
    "skillOverrides": {
        "claude-api": "off",
        "update-config": "off",
        "deep-research": "off",
        "verify": "off",
        "keybindings-help": "off",
        "fewer-permission-prompts": "off",
        "simplify": "off",
        "security-review": "off",
        "init": "off",
        "review": "off",
        "teach-impeccable": "off",
        "writing": "off",
    },
    "permissions": {
        "deny": [
            "Agent(claude-code-guide)",
            "Agent(Explore)",
            "Agent(statusline-setup)",
            "mcp__octocode__packageSearch",
            "Agent(caveman:cavecrew-builder)",
            "Agent(caveman:cavecrew-reviewer)",
            "Agent(caveman:cavecrew-investigator)",
        ],
        "ask": [],
        "defaultMode": "bypassPermissions",
    },
    "enabledPlugins": {},
    "fastMode": True,
    "mcpServers": {},
}
os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
with open(dest, "w", encoding="utf-8") as f:
    json.dump(panel, f, indent=2)
    f.write("\n")
PY
}

# _unifusion_write_codex_panel_config <codex_home> <model> <effort>
# Panel isolation for codex: live hooks.json, fast service tier, hooks+code_mode, Exa MCP only.
_unifusion_write_codex_panel_config() {
  local codex_home="${1:?codex_home required}"
  local model="${2:?model required}"
  local effort="${3:?effort required}"
  local hooks_src="${HOME}/.codex/hooks.json"
  local hooks_dest="${codex_home}/hooks.json"

  mkdir -p "$codex_home"
  for f in auth.json auth-2.json; do
    [ -f "${HOME}/.codex/$f" ] && cp "${HOME}/.codex/$f" "$codex_home/" 2>/dev/null
  done
  if [ ! -f "$hooks_src" ]; then
    echo "[_unifusion_lib] missing $hooks_src — cannot build codex panel config" >&2
    return 1
  fi
  cp "$hooks_src" "$hooks_dest"

  cat > "${codex_home}/config.toml" <<EOF
approval_policy = "never"
sandbox_mode = "danger-full-access"
suppress_unstable_features_warning = true
include_apps_instructions = false
personality = "none"
service_tier = "fast"
model = "$model"
model_reasoning_effort = "$effort"

[mcp_servers.exa]
url = "$UNIFUSION_EXA_MCP_URL"

[features]
hooks = true
code_mode = true
EOF
}

# _unifusion_write_gemini_panel_settings <gemini_home> <model> <thinking_level>
# Panel isolation for the standalone `gemini` CLI: an isolated $HOME/.gemini/settings.json with Exa-only
# MCP (no user skills/extensions/tavily), banner/telemetry/auto-update off, and two headless fixes:
#   - experimental.contextManagement=false  -> suppresses the context-calibrator 404 (the calibrator
#     pseudo-model only exists on Vertex/Code-Assist, not the api-key generativelanguage endpoint).
#   - context.discoveryMaxDirs=0            -> stops the project-context scan that hits unreadable
#     /tmp tmp-mount-* siblings of the throwaway workdir (EACCES warnings).
# Thinking effort is set via a custom alias extending the system gemini-3.5-flash-base (which carries the
# model id); for Gemini 3.x Flash the knob is thinkingConfig.thinkingLevel (MINIMAL|LOW|HIGH), not the
# numeric thinkingBudget (that is 2.5).
_unifusion_write_gemini_panel_settings() {
  local gemini_home="${1:?gemini_home required}"
  local model="${2:?model required}"
  local thinking_level="${3:?thinking_level required}"
  mkdir -p "$gemini_home/.gemini"
  EXA_URL="$UNIFUSION_EXA_MCP_URL" GMODEL="$model" GTHINK="$thinking_level" \
  python3 - "$gemini_home/.gemini/settings.json" <<'PY' || return 1
import json, os, sys
dest = sys.argv[1]
model = os.environ["GMODEL"]
settings = {
    "experimental": {"contextManagement": False},
    "ui": {"hideBanner": True},
    "privacy": {"usageStatisticsEnabled": False},
    "general": {"enableAutoUpdate": False},
    "security": {"auth": {"selectedType": "gemini-api-key"}},
    "context": {"discoveryMaxDirs": 0},
    "mcpServers": {"exa": {"type": "http", "url": os.environ["EXA_URL"]}},
    "modelConfigs": {
        "customAliases": {
            model: {
                "extends": "gemini-3.5-flash-base",
                "modelConfig": {
                    "generateContentConfig": {
                        "thinkingConfig": {
                            "thinkingLevel": os.environ["GTHINK"],
                            "includeThoughts": False,
                        }
                    }
                },
            }
        }
    },
}
os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
with open(dest, "w", encoding="utf-8") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PY
}

# _kimi_bin — print the path to the real kimi binary, never the shell alias (often `kimi --yolo`,
# which conflicts with print mode: "Cannot combine --prompt with --yolo").
# Precedence: UNIFUSION_KIMI_BIN > ~/.kimi-code/bin/kimi > command -P kimi (bash, ignores aliases).
_kimi_bin() {
  if [ -n "${UNIFUSION_KIMI_BIN:-}" ] && [ -x "${UNIFUSION_KIMI_BIN:-}" ]; then
    printf '%s\n' "$UNIFUSION_KIMI_BIN"
    return 0
  fi
  if [ -x "${HOME}/.kimi-code/bin/kimi" ]; then
    printf '%s\n' "${HOME}/.kimi-code/bin/kimi"
    return 0
  fi
  if command -P kimi >/dev/null 2>&1; then
    command -P kimi
    return 0
  fi
  return 1
}
have_kimi() { _kimi_bin >/dev/null 2>&1; }

# _run_with_timeout SECONDS cmd [args...]
# Exit status = the command's own status, or 124 if it was killed for timing out.
# Child runs in its own process group so timeout/signals reap the whole subtree.
_run_with_timeout() {
  local secs="$1"; shift
  perl -e '
    use POSIX ();
    my $secs = shift @ARGV;
    my $pid = fork();
    exit 127 unless defined $pid;
    if ($pid == 0) { POSIX::setpgid(0, 0); exec @ARGV or exit 127; }  # child: own pgroup, become the command
    POSIX::setpgid($pid, $pid);                                       # race-proof: set it from the parent too
    my $reap = sub {
      kill("TERM", -$pid); kill("TERM", $pid);   # negative pid => the whole process group
      sleep 2;
      kill("KILL", -$pid); kill("KILL", $pid);
    };
    local $SIG{ALRM} = $reap;                          # deadline => terminate the child group
    local $SIG{TERM} = sub { $reap->(); exit 143; };   # wrapper killed => take the group with us
    local $SIG{INT}  = sub { $reap->(); exit 130; };
    alarm $secs;
    waitpid($pid, 0);
    my $rc = $?;
    alarm 0;
    exit 124 if ($rc & 127);   # killed by a signal (our TERM/KILL) => timed out
    exit($rc >> 8);            # otherwise propagate the command exit code
  ' "$secs" "$@"
}
