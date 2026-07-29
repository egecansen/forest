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
# Anchored to the NEW hint's own wording. An earlier draft matched only "lock-kit.sh lock", which a
# pre-existing closing line already contained — so the assertion passed against an installer with no
# hint at all. Proven by mutation: with the guard and hint stripped, that version still reported 2/3.
case "$OUT" in *"WITHOUT that step nothing is protected"*) ok ;; *) bad "a fresh install must say plainly that nothing is protected yet, not just print a command" ;; esac

# now pretend it is hardened and re-run: the installer must stop, not spew cp errors
printf '{"tier":"hardened","at":"x"}\n' > "$P/.claude/skills/hektor-flaky-triage/core/.lock-state"
OUT="$("$KITSRC/install.sh" --harness claude --project "$P" 2>&1)"; RC=$?
# Anchored to the refusal's own wording for the same reason — the old boilerplate also contains
# "unlock", so matching that alone could not distinguish "guard refused" from "guard absent and the
# usual closing text printed".
case "$OUT" in *"refusing to overwrite"*) ok ;; *) bad "re-installing over a hardened kit must print the refusal, not just any text containing 'unlock'" ;; esac
[ "$RC" -ne 0 ] && ok || bad "re-installing over a hardened kit must exit non-zero"

echo "install-guard-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
