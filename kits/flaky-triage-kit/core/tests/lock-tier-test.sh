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

# --- the HARDENED branch, driven WITHOUT root via a PATH-shimmed sudo -------------
# An earlier draft of this plan asserted the hardened path could not be tested because it needs a
# password. That is false, and leaving harden_targets() — the function that decides what becomes
# root-owned — with zero coverage is how its first version shipped a two-command bypass. A shim
# that logs its arguments, no-ops `chown`, and execs everything else drives the whole branch as an
# unprivileged user: it cannot prove root ownership, but it pins the call SEQUENCE, the target
# SET, and the counters, which is where the defects actually live.
SHIM="$TMP/bin"; mkdir -p "$SHIM"
cat > "$SHIM/sudo" <<'SH'
#!/bin/bash
echo "$@" >> "$SUDO_LOG"
case "$1" in chown) exit 0 ;; *) exec "$@" ;; esac
SH
chmod +x "$SHIM/sudo"
export SUDO_LOG="$TMP/sudo.log"; : > "$SUDO_LOG"
KIT2="$TMP/kit2"; mkdir -p "$KIT2/core" "$KIT2/hooks"
cp "$LOCK" "$KIT2/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KIT2/core/_integrity.sh"
printf '{}\n' > "$KIT2/core/config.json"; printf 'x\n' > "$KIT2/SKILL.md"
printf 'x\n' > "$KIT2/hooks/flaky-kit-self-protection-gate.sh"; chmod +x "$KIT2/core/lock-kit.sh"
# The tier decision now reads REAL observed ownership (integrity_owner_uid), not chown's exit code
# (Important 2) — correctly so, but that means the sudo shim's no-op `chown` (above) can never by
# itself flip the fixture to root-owned, since nothing here can perform a genuine chown(2) to uid 0
# without the password this whole fixture exists to avoid. Stubbing `stat` the same way the `id`
# stub below fakes "already root" for the exit-78 path: report uid 0 ONLY for $KIT2/core's owner
# query — exactly what a real successful `sudo chown -R root` would leave behind — so the REAL,
# unmodified observation-based decision in lock-kit.sh is what gets exercised end-to-end. Every
# other path/flag still falls through to the real binary.
export STAT_TARGET="$KIT2/core"
cat > "$SHIM/stat" <<'SH'
#!/bin/bash
for a in "$@"; do
  [ "$a" = "$STAT_TARGET" ] && { echo 0; exit 0; }
done
exec /usr/bin/stat "$@"
SH
chmod +x "$SHIM/stat"
HOUT="$(PATH="$SHIM:$PATH" "$KIT2/core/lock-kit.sh" lock 2>&1)"

case "$HOUT" in *HARDENED*) ok ;; *) bad "with sudo available the lock must reach the hardened tier" ;; esac
case "$HOUT" in *"0 files"*) bad "hardened counters must not report 0 — priv_chmod must escalate too" ;; *) ok ;; esac
grep -q "chown -R root" "$SUDO_LOG" && ok || bad "hardened lock must chown the surface to root"
# THE regression guard for the two-command bypass: the kit ROOT must be a chown target, not just core/.
grep -qE "chown -R root .*(^| )$KIT2( |$)" "$SUDO_LOG" && ok \
  || bad "the kit root itself must be chowned — otherwise chmod u+w \$KIT + mv core aside bypasses the wall with no password"
grep -q "$KIT2/hooks" "$SUDO_LOG" && ok || bad "hooks/ is on the surface and must be chowned"
grep -q "$KIT2/SKILL.md" "$SUDO_LOG" && ok || bad "SKILL.md is on the surface and must be chowned"
# Ordering: the state write must come BEFORE the write bits are stripped.
[ "$(grep -n 'tee' "$SUDO_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n 'chmod' "$SUDO_LOG" | head -1 | cut -d: -f1)" ] \
  && ok || bad "state must be written before the chmod sweep, or it lands in a read-only directory"
case "$HOUT" in *"renamed aside"*) ok ;; *) bad "the hardened message must state the parent-rename residual instead of claiming an absolute" ;; esac

# The no-invoking-user refusal (exit 78) is reachable with an `id` stub — it is not dead code.
cat > "$SHIM/id" <<'SH'
#!/bin/bash
[ "$1" = "-un" ] && { echo root; exit 0; }; exec /usr/bin/id "$@"
SH
chmod +x "$SHIM/id"
HEKTOR_FLAKYKIT_UNLOCK=1 PATH="$SHIM:$PATH" HEKTOR_FK_NO_SUDO=1 "$KIT2/core/lock-kit.sh" unlock >/dev/null 2>&1
[ "$?" -eq 78 ] && ok || bad "unlock must refuse with 78 when there is no invoking user to hand ownership back to"

# _integrity.sh missing: lock-kit.sh must refuse loud (exit 69), not silently run with undefined
# tier functions — a safety tool that half-loads is the exact failure mode this project targets.
KIT3="$TMP/kit-no-integrity"; mkdir -p "$KIT3/core"
cp "$LOCK" "$KIT3/core/lock-kit.sh"; chmod +x "$KIT3/core/lock-kit.sh"
HEKTOR_FK_NO_SUDO=1 "$KIT3/core/lock-kit.sh" status >/dev/null 2>&1
[ "$?" -eq 69 ] && ok || bad "lock-kit.sh must refuse to run (exit 69) when _integrity.sh is missing"

echo "lock-tier-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
