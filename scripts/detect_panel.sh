#!/usr/bin/env bash
# detect_panel.sh — figure out which panelist CLIs are installed and recommend a Unifusion panel.
#
# Unifusion fans a prompt out to a panel of models in parallel, then Opus 4.8 judges. Opus 4.8 is always
# available as a panelist via the Agent tool (in-process subagents) and is always the judge — so it never
# needs a CLI check. This script probes the *external* panelist CLIs and builds the richest panel the
# machine can currently support:
#
#   GPT-5.5        via codex   -> -gpt5.5
#   Gemini 3.5 Flash via agy     -> -gemini3.5flash
#   Kimi K2.7      via kimi     -> -kimi2.7
#   GLM-5.2        via devin    -> -glm5.2
#
# The slug reads driver-first (opus4.8) then one token per available external family. With no external
# CLI at all it falls back to two independent Opus 4.8 runs (opus4.8-4.8).
#
# Output: human-readable lines + a final `SLUG=...` line the orchestrator can grep.

have() { command -v "$1" >/dev/null 2>&1; }

codex_ok=false; agy_ok=false; kimi_ok=false; devin_ok=false
have codex && codex_ok=true
have agy   && agy_ok=true
have kimi  && kimi_ok=true
have devin && devin_ok=true

yn() { [ "$1" = true ] && echo yes || echo NO; }

echo "panelist availability (Opus 4.8 is always a panelist + the judge, via Agent subagents):"
echo "  opus4.8      : yes (Agent subagents — always available)"
printf "  gpt5.5       : %s (codex CLI)\n"  "$(yn "$codex_ok")"
printf "  gemini3.5flash : %s (agy CLI)\n"    "$(yn "$agy_ok")"
printf "  kimi2.7      : %s (kimi CLI)\n"   "$(yn "$kimi_ok")"
printf "  glm5.2       : %s (devin CLI)\n"  "$(yn "$devin_ok")"
echo

slug="opus4.8"
ext=0
$codex_ok && { slug="$slug-gpt5.5";       ext=$((ext + 1)); }
$agy_ok   && { slug="$slug-gemini3.5flash";  ext=$((ext + 1)); }
$kimi_ok  && { slug="$slug-kimi2.7";       ext=$((ext + 1)); }
$devin_ok && { slug="$slug-glm5.2";        ext=$((ext + 1)); }
[ "$ext" -eq 0 ] && slug="opus4.8-4.8"

echo "recommended panel: $slug"
echo "SLUG=$slug"
