#!/bin/bash
# Test suite for core/lock-kit.sh's tier behaviour that does NOT need root.
#
# A real `chown` to uid 0 needs a password and cannot happen here. Everything ELSE about the
# privileged path can and does: a PATH-shimmed `sudo` records the argv and no-ops the chown, and a
# PATH-shimmed `stat` reports the ownership a successful chown WOULD have left behind, so the real,
# unmodified observation-based tier decision in lock-kit.sh runs end-to-end as an unprivileged user.
# Only "is uid 0 really uid 0" is deferred to docs/superpowers/plans/2026-07-29-flaky-kit-lock-manual-acceptance.md.
#
# NOTE for anyone running this file: do NOT wrap it in HEKTOR_FK_NO_SUDO=1. The shimmed-sudo sections
# below need `have_sudo` to succeed; forcing the degraded path makes them fail spuriously.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$HERE/../lock-kit.sh"
# `pwd -P`: on macOS mktemp -d hands back a /var/folders/... path whose /var is a symlink to
# /private/var. `git rev-parse --show-toplevel` (which harden_targets uses to find the out-of-tree
# gate scripts) always answers with the PHYSICAL path, so a fixture kept in symlink form would make
# the assertions below compare two spellings of the same directory and fail for no real reason.
TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
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
STATUS_OUT="$(HEKTOR_FK_NO_SUDO=1 "$KIT/core/lock-kit.sh" status 2>&1)"
case "$STATUS_OUT" in
  *"tier: degraded"*) ok ;; *) bad "status must print the tier line" ;;
esac
# The owner column: `[ -w ]` is false for BOTH a root-owned path and a user-owned `a-w` one, so
# writability alone cannot distinguish the hardened tier from the degraded one, nor show which paths a
# partial chown missed. Spec §6 asked for per-path reporting; per-path WRITABILITY does not deliver it.
case "$STATUS_OUT" in *"core/config.json  owner=$(id -un)"*) ok ;; *) bad "status must report the OWNER of each surface path, not only its writability — got: $STATUS_OUT" ;; esac
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
#
# SUDO_CHOWN_FAIL makes one chosen operand fail the way a real refusal does (stderr + non-zero), so
# the PARTIAL-hardening path — core/ rooted, something else not — is reachable too. SUDO_CHOWN_FAIL_ALL
# fails EVERY chown operand (simulating an authenticated password whose chown then fails across the
# board — e.g. an immutable flag or a read-only mount), rather than just one named operand: it models
# "the credential was cached but nothing landed", not "the credential was cached and most of it
# landed". `-k` is answered without exec'ing, because `sudo -k` is a sudo builtin, not a command to run
# — and it is logged regardless of any FAIL flag, since the whole point of the fixtures below is
# proving `-k` still runs when the chown(s) it follows failed.
SHIM="$TMP/bin"; mkdir -p "$SHIM"
cat > "$SHIM/sudo" <<'SH'
#!/bin/bash
echo "$@" >> "$SUDO_LOG"
case "$1" in
  -k) exit 0 ;;
  chown)
    if [ -n "${SUDO_CHOWN_FAIL_ALL:-}" ]; then
      echo "chown: Operation not permitted" >&2
      exit 1
    fi
    if [ -n "${SUDO_CHOWN_FAIL:-}" ]; then
      for a in "$@"; do
        [ "$a" = "$SUDO_CHOWN_FAIL" ] && { echo "chown: $a: Operation not permitted" >&2; exit 1; }
      done
    fi
    exit 0 ;;
  *) exec "$@" ;;
esac
SH
chmod +x "$SHIM/sudo"
export SUDO_LOG="$TMP/sudo.log"; : > "$SUDO_LOG"
# The tier decision reads REAL observed ownership (integrity_owner_uid), not chown's exit code —
# correctly so, but that means the sudo shim's no-op `chown` can never by itself flip the fixture to
# root-owned, since nothing here can perform a genuine chown(2) to uid 0 without the password this
# whole fixture exists to avoid. So `stat` is stubbed the same way the `id` stub below fakes
# "already root": report uid 0 for the paths in STAT_TARGETS — exactly what a real successful
# `sudo chown -R root` would leave behind — so the REAL, unmodified observation-based decision in
# lock-kit.sh is what gets exercised end-to-end.
#
# ONLY the numeric `%u` query is intercepted. `status`'s owner column asks for `%Su` (the NAME) and
# must fall through to the real binary, or the column would be reporting the stub instead of the disk.
cat > "$SHIM/stat" <<'SH'
#!/bin/bash
case " $* " in *" %u "*) ;; *) exec /usr/bin/stat "$@" ;; esac
_targets="${STAT_TARGETS:-}"
IFS=:
for t in $_targets; do
  for a in "$@"; do [ "$a" = "$t" ] && { echo 0; exit 0; }; done
done
unset IFS
exec /usr/bin/stat "$@"
SH
chmod +x "$SHIM/stat"

# $KIT2/hooks is the PRE-RELOCATION layout: install.sh no longer creates an in-tree hooks/ and now
# deletes a stale one on upgrade, but `lock` can still be run on an install that predates the move
# and whose hooks/ holds a REAL gate script. surface_files()/surface_dirs()/harden_targets() keep
# their $KIT/hooks branches as explicit upgrade-path handling (see the comment above surface_files),
# so the fixture creates it on purpose to cover that path rather than as a leftover.
KIT2="$TMP/kit2"; mkdir -p "$KIT2/core" "$KIT2/hooks"
cp "$LOCK" "$KIT2/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KIT2/core/_integrity.sh"
printf '{}\n' > "$KIT2/core/config.json"; printf 'x\n' > "$KIT2/SKILL.md"
printf 'x\n' > "$KIT2/hooks/flaky-kit-self-protection-gate.sh"; chmod +x "$KIT2/core/lock-kit.sh"
# Both core/ AND the kit root report root-owned, i.e. a COMPLETE hardening — so the full banner (not
# the PARTIAL one) is what this section exercises. The partial case gets its own fixture below.
export STAT_TARGETS="$KIT2/core:$KIT2"
HOUT="$(PATH="$SHIM:$PATH" "$KIT2/core/lock-kit.sh" lock 2>&1)"

# Exact-operand helpers. `grep -q "$KIT2/hooks" "$SUDO_LOG"` is NOT good enough: the `chmod a-w`
# sweep lines in the same log mention every file UNDER that directory, so such an assertion passed
# even with $KIT/hooks deleted from harden_targets (mutation-verified: 19/0 green, asserting nothing).
# Splitting a specific line kind into words and comparing whole words is exact.
chown_r_operands() { grep '^chown -R root ' "$SUDO_LOG" | tr ' ' '\n'; }

case "$HOUT" in *HARDENED*) ok ;; *) bad "with sudo available the lock must reach the hardened tier" ;; esac
# priv_chmod must ESCALATE in the hardened tier. The old assertion here only checked that the banner
# did not say "0 files" — which stayed true with priv_chmod's escalation removed, because the fixture's
# files are user-owned and a plain chmod succeeds on them. Assert the escalation itself: on a really
# root-owned surface an unprivileged chmod is EPERM, so if this line is missing the counters lie.
grep -qxF "chmod a-w $KIT2/core/config.json" "$SUDO_LOG" && ok \
  || bad "priv_chmod must run the chmod sweep through sudo in the hardened tier — an unprivileged chmod on a root-owned path is EPERM and the banner's counters would be false"
grep -q "chown -R root" "$SUDO_LOG" && ok || bad "hardened lock must chown the surface to root"
# THE regression guard for the two-command bypass: the kit ROOT must be a chown target, not just core/.
grep -qxF "chown root $KIT2" "$SUDO_LOG" && ok \
  || bad "the kit root itself must be chowned — otherwise chmod u+w \$KIT + mv core aside bypasses the wall with no password"
# ...and it must NOT be an operand of the RECURSIVE call: `chown -R` applies to EVERY operand, so in
# the SOURCE checkout (which the release flow re-locks after merge) that one call would root
# adapters/, install.sh, kernel.md, README.md and scripts/ — all git-tracked.
chown_r_operands | grep -qxF "$KIT2" \
  && bad "the kit root must NOT be an operand of 'chown -R' — -R applies to every operand and would recurse the whole source checkout" || ok
chown_r_operands | grep -qxF "$KIT2/hooks" && ok \
  || bad "a pre-relocation in-tree hooks/ is on the surface and must be a chown OPERAND (not merely mentioned by the chmod sweep)"
chown_r_operands | grep -qxF "$KIT2/SKILL.md" && ok \
  || bad "SKILL.md is on the surface and must be a chown OPERAND (not merely mentioned by the chmod sweep)"
# Ordering: the state write must come BEFORE the write bits are stripped. Both line numbers are
# checked for emptiness first — an absent match used to make `[` print
# "integer expression expected" and fail for the wrong reason, hiding what actually broke.
TEE_LN="$(grep -n 'tee' "$SUDO_LOG" | head -1 | cut -d: -f1)"
CHMOD_LN="$(grep -n 'chmod' "$SUDO_LOG" | head -1 | cut -d: -f1)"
{ [ -n "$TEE_LN" ] && [ -n "$CHMOD_LN" ] && [ "$TEE_LN" -lt "$CHMOD_LN" ]; } \
  && ok || bad "state must be written (sudo tee) before the chmod sweep, or it lands in a read-only directory (tee=${TEE_LN:-none} chmod=${CHMOD_LN:-none})"
case "$HOUT" in *"renamed aside"*) ok ;; *) bad "the hardened message must state the parent-rename residual instead of claiming an absolute" ;; esac
case "$HOUT" in *"Protection against edit, not against replacement"*) ok ;; *) bad "the hardened message must state the out-of-tree residual too: root-owned gate scripts sit in user-owned directories and can be replaced" ;; esac
# The credential this run cached must be dropped when the privileged section ends: sudo's default
# timestamp_timeout leaves a ~5-minute window in which the agent can re-run the unlock with NO
# prompt (and detect the window with `sudo -n true`), so "reopening needs a password" is otherwise
# false for that window — a window `lock` itself opened.
grep -qxF -- "-k" "$SUDO_LOG" && ok || bad "lock must end its privileged section with 'sudo -k' — otherwise it leaves a no-prompt reopen window it created itself"
K_LN="$(grep -n -x -- '-k' "$SUDO_LOG" | tail -1 | cut -d: -f1)"
LAST_CHMOD_LN="$(grep -n 'chmod' "$SUDO_LOG" | tail -1 | cut -d: -f1)"
{ [ -n "$K_LN" ] && [ -n "$LAST_CHMOD_LN" ] && [ "$K_LN" -gt "$LAST_CHMOD_LN" ]; } \
  && ok || bad "'sudo -k' must come AFTER the last privileged chmod, or the sweep loses its own credential mid-run (k=${K_LN:-none} last chmod=${LAST_CHMOD_LN:-none})"

# --- PARTIAL hardening: core/ rooted, the kit root NOT ------------------------------
# `chown -R` over several operands exits non-zero if ANY fail but does not roll back the ones that
# succeeded. The tier is sampled from core/ alone, so this lands on TIER=hardened with $KIT still
# user-owned. Two things used to go wrong at once and both are asserted here: sudo's stderr was
# printed ONLY when the tier came out degraded (so the one explanation was swallowed), and the banner
# asserted "including the kit root, is owned by root" unconditionally (so it printed something false).
: > "$SUDO_LOG"
KITP="$TMP/kit-partial"; mkdir -p "$KITP/core"
cp "$LOCK" "$KITP/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KITP/core/_integrity.sh"
printf '{}\n' > "$KITP/core/config.json"; chmod +x "$KITP/core/lock-kit.sh"
export STAT_TARGETS="$KITP/core"          # core/ looks root-owned; $KITP does not
POUT="$(SUDO_CHOWN_FAIL="$KITP" PATH="$SHIM:$PATH" "$KITP/core/lock-kit.sh" lock 2>&1)"
case "$POUT" in *"sudo said"*) ok ;; *) bad "a chown that failed on one operand must print sudo's own words EVEN when the tier still came out hardened — got: $POUT" ;; esac
case "$POUT" in *"HARDENED (PARTIAL)"*) ok ;; *) bad "a hardened tier whose kit root is NOT root-owned must announce itself as PARTIAL" ;; esac
case "$POUT" in *"including the kit root, is owned by root"*) bad "the banner must not claim the kit root is root-owned when it is not — the clause has to be derived from the real owner" ;; *) ok ;; esac

# The mirror image: chown succeeds on SKILL.md and fails on core/, so the tier lands on DEGRADED with
# part of the surface root-owned. "the surface is still owned by $ME" would then be false in the other
# direction — the same defect, pointed the other way.
: > "$SUDO_LOG"
KITU="$TMP/kit-uneven"; mkdir -p "$KITU/core"
cp "$LOCK" "$KITU/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KITU/core/_integrity.sh"
printf '{}\n' > "$KITU/core/config.json"; printf 'x\n' > "$KITU/SKILL.md"; chmod +x "$KITU/core/lock-kit.sh"
export STAT_TARGETS="$KITU/SKILL.md"      # SKILL.md looks root-owned; core/ does not
UOUT="$(PATH="$SHIM:$PATH" "$KITU/core/lock-kit.sh" lock 2>&1)"
case "$UOUT" in *DEGRADED*) ok ;; *) bad "with core/ not root-owned the tier must be DEGRADED — got: $UOUT" ;; esac
case "$UOUT" in *"UNEVENLY"*) ok ;; *) bad "a degraded lock with SOME surface paths root-owned must say the escalation applied unevenly, not claim the whole surface is still user-owned — got: $UOUT" ;; esac
case "$UOUT" in *"the surface is still owned by"*) bad "the degraded banner must not make a blanket ownership claim over the whole surface — core/ is what the tier is sampled from" ;; *) ok ;; esac
# R2: this UNEVEN case is exactly one of the two states measured to SKIP `sudo -k` when it was gated
# on `$TIER = hardened` — SKILL.md authenticated and got chowned, core/ did not, so TIER lands on
# degraded even though a real password was just typed and cached. `sudo -k` must still run: the
# credential exists because `sudo chown` ran, not because the tier it produced was hardened.
grep -qxF -- "-k" "$SUDO_LOG" && ok \
  || bad "an UNEVEN lock (SKILL.md rooted, core/ not — TIER=degraded) must still end with 'sudo -k': the credential authenticated on SKILL.md even though the tier came out degraded"

# The other state measured to skip it: a chown that AUTHENTICATES but then fails on EVERY operand
# (immutable flag, read-only mount, ...) also lands on TIER=degraded — same bug, pointed the other
# way. Distinguishes "escalation attempted" from "escalation landed anywhere": both are degraded, but
# only the credential's existence (not its success) should gate the drop.
: > "$SUDO_LOG"
KITF="$TMP/kit-fail-all"; mkdir -p "$KITF/core"
cp "$LOCK" "$KITF/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KITF/core/_integrity.sh"
printf '{}\n' > "$KITF/core/config.json"; chmod +x "$KITF/core/lock-kit.sh"
unset STAT_TARGETS                                      # nothing reports root-owned: chown "fails" everywhere
FOUT="$(SUDO_CHOWN_FAIL_ALL=1 PATH="$SHIM:$PATH" "$KITF/core/lock-kit.sh" lock 2>&1)"
case "$FOUT" in *DEGRADED*) ok ;; *) bad "a chown that fails on EVERY operand must still land on DEGRADED — got: $FOUT" ;; esac
grep -qxF -- "-k" "$SUDO_LOG" && ok \
  || bad "a lock whose chown authenticated but failed on EVERY operand must still end with 'sudo -k' — the credential was cached the moment sudo ran, before any of the chowns failed"

# --- a realistic install layout: both harnesses' gates + libs, and the out-of-tree record ----------
# harden_targets() covered core/, [hooks/], SKILL.md, the CLAUDE gate and the kit root. It did NOT
# cover the CURSOR gate, the Cursor libs, or .claude/hooks/lib/audit.sh — all three declared part of
# the safety surface by SURF_RE, core/shell-guard.py, the CODEOWNERS block and README.md, and
# installed by install.sh whenever --harness includes cursor. So a Cursor user could run `lock`, read
# "the safety surface … is owned by root", and still have their ONLY gate user-writable.
: > "$SUDO_LOG"; unset SUDO_CHOWN_FAIL
PROJ5="$TMP/proj5"; KIT5="$PROJ5/.claude/skills/hektor-flaky-triage"
mkdir -p "$KIT5/core" "$PROJ5/.claude/hooks/lib" "$PROJ5/.cursor/hooks/lib"
git -C "$PROJ5" init -q
cp "$LOCK" "$KIT5/core/lock-kit.sh"; cp "$HERE/../_integrity.sh" "$KIT5/core/_integrity.sh"
printf '{}\n' > "$KIT5/core/config.json"; printf 'x\n' > "$KIT5/SKILL.md"; chmod +x "$KIT5/core/lock-kit.sh"
printf 'x\n' > "$PROJ5/.claude/hooks/flaky-kit-self-protection-gate.sh"
printf 'x\n' > "$PROJ5/.claude/hooks/lib/audit.sh"
printf 'x\n' > "$PROJ5/.cursor/hooks/flaky-kit-self-protection-gate.sh"
printf 'x\n' > "$PROJ5/.cursor/hooks/lib/cursor-compat.sh"
printf 'x\n' > "$PROJ5/.cursor/hooks/lib/audit.sh"
export STAT_TARGETS="$KIT5/core:$KIT5"
H5OUT="$(PATH="$SHIM:$PATH" "$KIT5/core/lock-kit.sh" lock 2>&1)"
case "$H5OUT" in *"HARDENED "*) ok ;; *) bad "the install-shaped fixture must reach a complete hardened tier — got: $H5OUT" ;; esac
chown_r_operands | grep -qxF "$PROJ5/.claude/hooks/flaky-kit-self-protection-gate.sh" && ok \
  || bad "the Claude gate must be a chown operand"
chown_r_operands | grep -qxF "$PROJ5/.cursor/hooks/flaky-kit-self-protection-gate.sh" && ok \
  || bad "the CURSOR gate must be a chown operand — install.sh installs it and it is a Cursor user's only gate"
chown_r_operands | grep -qxF "$PROJ5/.cursor/hooks/lib/cursor-compat.sh" && ok \
  || bad "the Cursor gate's vendored compat lib must be a chown operand — SURF_RE declares .cursor/hooks/lib/ part of the surface"
chown_r_operands | grep -qxF "$PROJ5/.cursor/hooks/lib/audit.sh" && ok \
  || bad "the Cursor audit lib must be a chown operand"
chown_r_operands | grep -qxF "$PROJ5/.claude/hooks/lib/audit.sh" && ok \
  || bad "the Claude audit lib must be a chown operand — it is the file that records the unlock"
# The out-of-tree record: lock must write the tier it achieved, because the gates' shadow check reads
# exactly this file. Nothing asserted this before, and deleting the write left the whole suite green.
[ -f "$PROJ5/.claude/hooks/.flaky-kit-expect" ] && ok || bad "lock must mirror the tier OUTSIDE the kit tree in .claude/hooks/.flaky-kit-expect"
[ "$(cat "$PROJ5/.claude/hooks/.flaky-kit-expect" 2>/dev/null)" = hardened ] && ok \
  || bad "the out-of-tree record must say 'hardened' after a hardened lock — the gates' shadow check keys off this exact value"
# status must surface the OUT-OF-TREE paths too: they are hardened targets that live outside $KIT and
# would otherwise never be reportable, which is how a Cursor user would never learn their gate was missed.
S5="$(PATH="$SHIM:$PATH" "$KIT5/core/lock-kit.sh" status 2>&1)"
case "$S5" in *".cursor/hooks/flaky-kit-self-protection-gate.sh  owner="*) ok ;; *) bad "status must report the out-of-tree surface (the Cursor gate) with its owner — got: $S5" ;; esac

# hardened UNLOCK: the chown-back and the record refresh. Neither was covered — deleting the hardened
# chown-back left the whole suite green.
: > "$SUDO_LOG"
U5="$(HEKTOR_FLAKYKIT_UNLOCK=1 PATH="$SHIM:$PATH" "$KIT5/core/lock-kit.sh" unlock 2>&1)"
case "$U5" in *UNLOCKED*) ok ;; *) bad "a hardened unlock must report UNLOCKED — got: $U5" ;; esac
grep '^chown -R ' "$SUDO_LOG" | tr ' ' '\n' | grep -qxF "$KIT5/core" && ok \
  || bad "a hardened unlock must chown the surface back to the invoking user"
grep '^chown -R ' "$SUDO_LOG" | tr ' ' '\n' | grep -qxF "$PROJ5/.cursor/hooks/flaky-kit-self-protection-gate.sh" && ok \
  || bad "a hardened unlock must hand the Cursor gate back too, or the next edit to it fails confusingly"
grep -qxF "chown $(id -un) $KIT5" "$SUDO_LOG" && ok \
  || bad "a hardened unlock must chown the kit ROOT back, non-recursively, mirroring lock"
grep '^chown -R ' "$SUDO_LOG" | tr ' ' '\n' | grep -qxF "$KIT5" \
  && bad "the kit root must not be an operand of unlock's 'chown -R' either — same source-checkout hazard as lock" || ok
[ "$(cat "$PROJ5/.claude/hooks/.flaky-kit-expect" 2>/dev/null)" = unlocked ] && ok \
  || bad "unlock must refresh the out-of-tree record to 'unlocked' — leaving it at 'hardened' makes every legitimate maintenance window look like a shadowed kit to both gates"
grep -qxF -- "-k" "$SUDO_LOG" && ok || bad "unlock must end its privileged section with 'sudo -k' as well"

# unlock's chown-back must trigger on ANY root-owned surface path, not just core/. With core/
# user-owned but the kit ROOT root-owned, the old core/-only gate skipped the chown-back entirely and
# the following `chmod u+w "$KIT"` then failed — a tree the tool could not reopen at all.
: > "$SUDO_LOG"
export STAT_TARGETS="$KIT5"               # ONLY the kit root looks root-owned
HEKTOR_FLAKYKIT_UNLOCK=1 PATH="$SHIM:$PATH" "$KIT5/core/lock-kit.sh" unlock >/dev/null 2>&1
grep -qxF "chown $(id -un) $KIT5" "$SUDO_LOG" && ok \
  || bad "unlock must chown back when ANY surface path is root-owned (here: the kit root but not core/), or a partially hardened tree has no supported way to reopen"

# R2: unlock's own exit-77 bailouts must not skip the credential drop either. The old code's single
# `sudo -k` sat at the TAIL of the unlock command, past both `exit 77` bailouts in the chown-back
# block above — so a `sudo chown -R $ME` that AUTHENTICATES (the password is typed, sudo caches it)
# and then fails (SUDO_CHOWN_FAIL_ALL models a stale operand / lingering immutable flag / read-only
# mount) took that early exit and left the just-cached credential live for the rest of sudo's
# ~5-minute timestamp_timeout — the same class of bug as `lock`'s, just reached via early exit
# instead of via a false gating variable. Reuses KIT5 (already hardened-shaped); STAT_TARGETS makes
# core/ look root-owned so hardened_any=1 and the chown-back is actually attempted.
: > "$SUDO_LOG"
export STAT_TARGETS="$KIT5/core"
EOUT="$(SUDO_CHOWN_FAIL_ALL=1 HEKTOR_FLAKYKIT_UNLOCK=1 PATH="$SHIM:$PATH" "$KIT5/core/lock-kit.sh" unlock 2>&1)"; ERC=$?
[ "$ERC" -eq 77 ] && ok || bad "unlock must abort with 77 when the chown-back authenticates but then fails on every operand — got rc=$ERC, out: $EOUT"
grep -qxF -- "-k" "$SUDO_LOG" && ok \
  || bad "unlock must drop the credential ('sudo -k') even on the exit-77 bailout above — otherwise a chown that authenticated and then failed leaves a cached credential live for the rest of the timestamp_timeout window"

# The no-invoking-user refusal (exit 78) is reachable with an `id` stub — it is not dead code.
# Created LAST: every section above needs the real `id`.
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
