#!/bin/bash
# Test suite for core/lock-kit.sh's tier behaviour that does NOT need root.
# The chown-to-root path needs a password and is covered by the manual acceptance checklist.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../lock-kit.sh"
TMP="$(mktemp -d)"; trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

# fixture: a kit-shaped tree we own, so lock must land in the DEGRADED tier
KIT="$TMP/kit"; mkdir -p "$KIT/core"
cp "$LOCK" "$KIT/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KIT/core/_integrity.sh"
printf '{}\n' > "$KIT/core/config.json"; chmod +x "$KIT/core/lock-kit.sh"

# With sudo forced unavailable, lock must degrade, say so, and still exit 0.
OUT="$(HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" lock 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok || bad "lock must exit 0 when it degrades (an approved outcome, not a failure)"
case "$OUT" in *DEGRADED*) ok ;; *) bad "a degraded lock must say DEGRADED explicitly" ;; esac
[ -f "$KIT/core/.lock-state" ] && ok || bad "lock must record the tier it achieved"
grep -q '"tier"[[:space:]]*:[[:space:]]*"degraded"' "$KIT/core/.lock-state" && ok || bad "state must record degraded"
[ -w "$KIT/core/config.json" ] && bad "degraded lock must still remove the write bit" || ok
case "$(HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" status 2>&1)" in
  *"tier: degraded"*) ok ;; *) bad "status must print the tier line" ;;
esac
# unlock still requires the intent marker
HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" unlock >/dev/null 2>&1
[ "$?" -eq 77 ] && ok || bad "unlock without HEKTOR_FLAKYKIT_UNLOCK must exit 77"
HEKTOR_FLAKYKIT_UNLOCK=1 HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" unlock >/dev/null 2>&1
[ -w "$KIT/core/config.json" ] && ok || bad "unlock with the intent marker must restore writability"
grep -q '"tier"[[:space:]]*:[[:space:]]*"unlocked"' "$KIT/core/.lock-state" && ok || bad "state must record unlocked"

echo "lock-tier-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
