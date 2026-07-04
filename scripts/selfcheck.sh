#!/usr/bin/env bash
# selfcheck.sh - unifusion release gate. Deterministic, portable, no paid API calls.
# Exits non-zero on any hard failure. Environment-specific checks (a live host session)
# are skipped with a note when unavailable rather than failing.
set -u
cd "$(dirname "$0")/.." || exit 9   # repo root
SC=scripts
pass=0; fail=0; skip=0
ok(){ pass=$((pass+1)); echo "PASS  $1"; }
no(){ fail=$((fail+1)); echo "FAIL  $1"; }
sk(){ skip=$((skip+1)); echo "SKIP  $1"; }
# scanned doc/script set, excluding this checker (it legitimately contains the literal token it scans for)
docs() { for f in README.md SKILL.md AGENTS.md references/*.md "$SC"/*.sh "$SC"/*.mjs "$SC"/*.py; do [ "$f" = "$SC/selfcheck.sh" ] || printf '%s\n' "$f"; done; }

# 1) syntax
node --check "$SC/compact-full-transcript.mjs" 2>/dev/null && ok "syntax: node --check" || no "syntax: node --check"
node --check "$SC/tool-use-format.mjs" 2>/dev/null && ok "syntax: tool-use-format.mjs" || no "syntax: tool-use-format.mjs"
node "$SC/test-tool-use-format.mjs" >/dev/null 2>&1 && ok "tool-use-format golden tests" || no "tool-use-format golden tests"
s=0; for f in "$SC"/*.sh; do bash -n "$f" 2>/dev/null || s=1; done
[ "$s" = 0 ] && ok "syntax: bash -n all shells" || no "syntax: bash -n all shells"

# 2) emoji-free (perl for portable unicode classes)
if perl -ne 'exit 1 if /[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{2190}-\x{21FF}]/' $(docs) 2>/dev/null; then ok "emoji-free"; else no "emoji-free"; fi

# 3) rebrand complete: no stray 'fusion' outside 'unifusion'
if perl -ne 'exit 1 if /(?i)(?<!uni)fusion/' $(docs) 2>/dev/null; then ok "rebrand: no stray 'fusion'"; else no "rebrand: no stray 'fusion'"; fi

# 4) content guard: foreign transcript + no key -> exit 3, no summary
printf '{"role":"user","parts":[{"text":"x"}]}\n' > /tmp/uf_foreign.jsonl
od=$(mktemp -d)
( unset GEMINI_API_KEY GOOGLE_API_KEY; node "$SC/compact-full-transcript.mjs" --provider gemini --input /tmp/uf_foreign.jsonl --out-dir "$od" --no-live-output ) >/dev/null 2>&1
[ $? -eq 3 ] && [ ! -f "$od/summary.md" ] && ok "content guard fail-closed (exit 3)" || no "content guard fail-closed"

# 5) multi-provider dry-run on a synthetic Claude-shaped transcript
printf '%s\n' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"unifusion selfcheck fixture"}]}}' > /tmp/uf_fix.jsonl
mp=0; for p in codex gemini xai mantle; do
  node "$SC/compact-full-transcript.mjs" --provider "$p" --input /tmp/uf_fix.jsonl --out-dir "$(mktemp -d)" --no-live-output --dry-run 2>/dev/null | grep -q "\"provider\": \"$p\"" || mp=1
done
[ "$mp" = 0 ] && ok "multi-provider dry-run (codex/gemini/xai/mantle)" || no "multi-provider dry-run"

# 6) Codex adapter on a synthetic rollout record
printf '%s\n' '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex fixture"}]}}' > /tmp/uf_codex.jsonl
r=$(node "$SC/compact-full-transcript.mjs" --provider gemini --input /tmp/uf_codex.jsonl --out-dir "$(mktemp -d)" --no-live-output --dry-run 2>/dev/null | grep -m1 '"transcript_records"' | grep -oE '[0-9]+')
[ "${r:-0}" -gt 0 ] && ok "Codex adapter (records=$r)" || no "Codex adapter"

# 7) Devin ATIF adapter on a synthetic ATIF document
printf '%s' '{"schema_version":"ATIF-v1.4","session_id":"x","agent":{"name":"devin"},"steps":[{"step_id":1,"source":"user","message":"atif fixture question"}]}' > /tmp/uf_atif.json
r=$(node "$SC/compact-full-transcript.mjs" --provider gemini --input /tmp/uf_atif.json --out-dir "$(mktemp -d)" --no-live-output --dry-run 2>/dev/null | grep -m1 '"transcript_records"' | grep -oE '[0-9]+')
[ "${r:-0}" -gt 0 ] && ok "Devin ATIF adapter (records=$r)" || no "Devin ATIF adapter"

# 8) resolver identity (environment-dependent)
if P=$(bash "$SC/resolve_session.sh" --path 2>/dev/null) && [ -n "$P" ] && [ -f "$P" ]; then
  eng=$(node "$SC/compact-full-transcript.mjs" --provider gemini --transcript "$P" --out-dir "$(mktemp -d)" --no-live-output --dry-run 2>/dev/null | grep -m1 '"transcript_sha256"' | grep -oE '[a-f0-9]{64}')
  [ "$eng" = "$(shasum -a256 "$P" | awk '{print $1}')" ] && ok "resolver sha==file" || no "resolver sha==file"
else sk "resolver (no host session in this environment)"; fi

# 9) git hygiene
[ -f .gitignore ] && ok ".gitignore present" || no ".gitignore present"
if git rev-parse --git-dir >/dev/null 2>&1; then
  git add -A -n 2>/dev/null | grep -qE '\.unifable|\.jsonl' && no "git: .unifable/*.jsonl ignored" || ok "git: .unifable/*.jsonl ignored"
else sk "git (not a repo here)"; fi

echo "----------------------------------------"
echo "selfcheck: $pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ] && { echo "selfcheck: PASS"; exit 0; } || { echo "selfcheck: FAIL"; exit 1; }
