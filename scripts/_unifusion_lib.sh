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
UNIFUSION_TIMEOUT="${UNIFUSION_TIMEOUT:-300}"

have() { command -v "$1" >/dev/null 2>&1; }

# _run_with_timeout SECONDS cmd [args...]
# Exit status = the command's own status, or 124 if it was killed for timing out.
_run_with_timeout() {
  local secs="$1"; shift
  # cleanup-traps: ok -- the child is killed via the embedded perl $SIG{ALRM,TERM,INT}
  # handlers below (on deadline, and if this wrapper is itself signaled), so no orphan leaks.
  perl -e '
    my $secs = shift @ARGV;
    my $pid = fork();
    exit 127 unless defined $pid;
    if ($pid == 0) { exec @ARGV or exit 127; }   # child: become the real command
    my $reap = sub { kill "TERM", $pid; sleep 2; kill "KILL", $pid; };
    local $SIG{ALRM} = $reap;                          # deadline => terminate the child
    local $SIG{TERM} = sub { $reap->(); exit 143; };   # wrapper killed => take the child with us
    local $SIG{INT}  = sub { $reap->(); exit 130; };
    alarm $secs;
    waitpid($pid, 0);
    my $rc = $?;
    alarm 0;
    exit 124 if ($rc & 127);   # killed by a signal (our TERM/KILL) => timed out
    exit($rc >> 8);            # otherwise propagate the command exit code
  ' "$secs" "$@"
}
