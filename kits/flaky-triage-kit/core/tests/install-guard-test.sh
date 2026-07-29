#!/bin/bash
# core/tests/install-guard-test.sh — install.sh must refuse to cp over a hardened kit instead of
# emitting a wall of EACCES, and must tell the user how to harden a fresh install.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KITSRC="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

P="$TMP/proj"; mkdir -p "$P"; git -C "$P" init -q
OUT="$("$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"
case "$OUT" in *"lock-kit.sh lock"*) ok ;; *) bad "a fresh install must tell the user how to harden" ;; esac

# now pretend it is hardened and re-run: the installer must stop, not spew cp errors
printf '{"tier":"hardened","at":"x"}\n' > "$P/.claude/skills/hektor-flaky-triage/core/.lock-state"
OUT="$("$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"; RC=$?
case "$OUT" in *"unlock"*) ok ;; *) bad "re-installing over a hardened kit must instruct to unlock first" ;; esac
[ "$RC" -ne 0 ] && ok || bad "re-installing over a hardened kit must exit non-zero"

echo "install-guard-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
