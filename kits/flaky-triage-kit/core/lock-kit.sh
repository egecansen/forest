#!/bin/bash
# core/lock-kit.sh — establishes the strongest OS-level protection tier it can on the kit's safety
# surface: hardened (root-owned, password-gated reopen) when possible, else a chmod read-only bit.
# See TIERS below — naming only "a read-only bit" here would describe the weaker, reversible tier.
#
# WHY
# ---
# The PreToolUse self-protection gate (`../hooks/flaky-kit-self-protection-gate.sh`) is the first
# line, but it is policy: it only bites where the CLI honors a `deny`, and a Bash redirect is
# matched only heuristically. A filesystem read-only bit is enforced by the OS for EVERY writer —
# Edit/Write tool, Bash `>`/`sed -i`, an injected script — so it is the wall the gate is not.
#
# Round2 (dirs, not just files): `chmod a-w` on FILES alone left a hole — deleting or renaming a
# file, and creating a brand-new one, are governed by the PARENT DIRECTORY's write bit, not the
# file's own. `cd core && rm apply.sh && printf >apply.sh` (and `echo x >core/new.json`) both
# succeeded on a "locked" kit for exactly this reason. Fixed by ALSO `chmod a-w`-ing every directory
# under core/ + hooks/ (recursively — nested dirs like core/tests/, core/capture-res/** need the
# same wall, not just the top-level core/) plus the kit root itself (so `core`/`hooks`/`SKILL.md`
# can't be renamed/deleted/shadowed out from under the lock either).
#
# TIERS. `lock` establishes the strongest tier it can:
#   hardened — core/** is owned by ROOT. chmod requires OWNERSHIP, so the agent (running as you)
#              cannot reverse it; reopening needs sudo, which needs a password only a human at the
#              keyboard can supply. THIS is human consent. HEKTOR_FLAKYKIT_UNLOCK is not consent —
#              it is an intent marker, and only sometimes a recorded one: the PreToolUse gate logs
#              its use when IT intercepts an agent's surface-mutating call, but running this script
#              directly — as `lock`/`unlock` always are — is not recorded anywhere by this file
#              (`hektor_audit` is never called here). The password above is the only real gate.
#   degraded — chmod a-w only, because sudo was unavailable or the escalation was refused. Honest
#              name: the surface IS read-only, but the same user — and therefore an agent running
#              as them — can chmod it back. Friction, not a wall.
#   unprotected — `lock` never ran here. Nothing is read-only; the surface is plainly writable. Do
#              NOT describe this state as "degraded": collapsing the two told fresh installs they
#              were protected when they were not — this file's own kind of mistake, pointed the
#              other way.
#
# The earlier version of this header called the chmod tier "a REAL wall" and its env-var unlock
# "keyed to human consent", and declared a shell-capable agent running as the file owner "out of
# scope". That agent is precisely what this kit constrains, and it defeated the lock with one
# documented command. Both claims are corrected rather than deleted, so the mistake stays legible.
#
# STILL NOT COVERED — the full list, because a partial one is how the last overclaim happened:
#   1. Shadowing. `mv` the kit dir aside and replace it. rename() is governed by the PARENT
#      directory, and $KIT's parent must stay user-writable so other skills can install there.
#      DETECTED via the gate's out-of-tree record, not prevented.
#   2. That record is itself deletable. Its directory stays user-owned (the pack installer writes
#      its own hooks there without sudo), so the same actor who renames the kit can erase the
#      expectation in the same breath. Chowning that directory WOULD close this; the decision not
#      to rests on the standing cost of routing every future pack-hook update through sudo, NOT on
#      any claim that it would not help. It would.
#   3. Social engineering a human into running the unlock.
#   4. Anything after the password is typed — keep the maintenance window short.
#   5. shell-guard.py honours HEKTOR_FK_SURFACE, which REPLACES its surface pattern wholesale; a
#      value matching nothing narrows the surface to nothing. Pre-existing, not introduced here.
#
# Reversible + git-clean: this toggles only the WRITE bit (`a-w` / `u+w`); it keeps the execute bit
# (dirs need it to stay traversable, scripts need it to stay runnable), so git sees no
# 100644<->100755 mode flip. It never touches file/dir CONTENT.
#
# Usage:  core/lock-kit.sh lock      # tries `sudo chown -R root` on the safety surface first (may
#                                    # prompt for a password); success reaches the HARDENED tier
#                                    # (password-gated reopen). Without sudo — or with it refused —
#                                    # it DEGRADES to the old chmod-a-w-only behaviour and says so
#                                    # loudly. HEKTOR_FK_NO_SUDO=1 forces the degraded path on purpose
#                                    # (used by the test suite and by anyone who wants the old
#                                    # behaviour without being prompted).
#         core/lock-kit.sh unlock    # chown back to the invoking user (if hardened) + chmod u+w —
#                                    # requires HEKTOR_FLAKYKIT_UNLOCK=1
#         core/lock-kit.sh status    # show writability of each surface file/dir + the recorded tier
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # .../hektor-flaky-triage/core
KIT="$(cd "$HERE/.." && pwd)"                            # .../hektor-flaky-triage
CMD="${1:-}"

# A safety tool that half-loads is worse than one that refuses: without this, a missing
# _integrity.sh leaves integrity_owner_uid/integrity_state/integrity_tier undefined and every call
# site below silently degrades to blank/empty output instead of failing loud. Refuse instead.
[ -r "$HERE/_integrity.sh" ] \
  || { echo "lock-kit: refusing to run — $HERE/_integrity.sh is missing; the tier logic (owner/state checks) cannot work without it" >&2; exit 69; }
. "$HERE/_integrity.sh"
STATE="$KIT/core/.lock-state"
ME="$(id -un 2>/dev/null)"

# Can we escalate? HEKTOR_FK_NO_SUDO=1 forces the degraded path (used by the test suite, and by
# anyone who wants the old behaviour). `sudo -n true` succeeds only with a cached/passwordless
# credential, so a plain `command -v sudo` is not enough of a probe on its own — but a password
# PROMPT is exactly what we want when the user is present, so we probe for the binary and let the
# real call prompt.
have_sudo() { [ "${HEKTOR_FK_NO_SUDO:-0}" = "1" ] && return 1; command -v sudo >/dev/null 2>&1; }
write_state() { printf '{"tier":"%s","at":"%s"}\n' "$1" "$(date -u +%FT%TZ 2>/dev/null || echo '?')" > "$STATE" 2>/dev/null; }

# The safety surface: all of core/ (logic + config + capture sources), the protection hook(s), the skill prompt.
surface_files() {
  find "$KIT/core"  -type f -print 2>/dev/null
  find "$KIT/hooks" -type f -print 2>/dev/null
  [ -f "$KIT/SKILL.md" ] && printf '%s\n' "$KIT/SKILL.md"
}

# Round2: every directory that can hold a surface file — core/ and hooks/ recursively, plus the
# kit root (so the top-level core/hooks/SKILL.md entries themselves can't be rm'd or renamed).
# chmod doesn't need write permission on the target's OWN parent to change the target's mode (only
# ownership + traverse/x on ancestors, which this never touches) — so lock/unlock order vs. files
# doesn't matter here.
surface_dirs() {
  find "$KIT/core"  -type d -print 2>/dev/null
  find "$KIT/hooks" -type d -print 2>/dev/null
  printf '%s\n' "$KIT"
}

# Everything that must be root-owned in the hardened tier. `chown -R` handles core/ recursively;
# SKILL.md and the relocated gate are single files. The gate lives OUTSIDE $KIT by design (Task 5)
# so a rename of the kit dir cannot take it along — which is exactly why it is listed separately.
harden_targets() {
  printf '%s\n' "$KIT/core"
  [ -d "$KIT/hooks" ] && printf '%s\n' "$KIT/hooks"
  [ -f "$KIT/SKILL.md" ] && printf '%s\n' "$KIT/SKILL.md"
  local root; root="$(git -C "$KIT" rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$root" ] && [ -f "$root/.claude/hooks/flaky-kit-self-protection-gate.sh" ]; then
    printf '%s\n' "$root/.claude/hooks/flaky-kit-self-protection-gate.sh"
  fi
  # $KIT LAST and non-recursively-meaningful: it is listed so the kit ROOT DIRECTORY itself changes
  # owner. This is load-bearing, not tidiness. `rename()` is governed by the write+execute bits of
  # the PARENT directory, never by the target's own bits or ownership — so with $KIT owned by the
  # invoking user, `chmod u+w "$KIT"` (which succeeds, because that user owns it) followed by
  # `mv "$KIT/core" "$KIT/core.bak" && mkdir "$KIT/core"` swaps in an attacker-controlled core/
  # without touching one root-owned file and without a password. Chowning only core/ therefore
  # reduces the hardened tier to a two-command bypass. Root-owning $KIT closes it.
  #
  # What this still does NOT close, and the HARDENED message must not claim it does: $KIT's own
  # parent (.claude/skills/) has to stay user-owned, because every other skill installs there — so
  # $KIT itself can be renamed aside by the same trick one level up. That residual is the design's
  # accepted one and is what the relocated gate's out-of-tree expectation detects (Task 6).
  printf '%s\n' "$KIT"
  return 0
}
# In the hardened tier the surface belongs to root, so THIS user's chmod would fail — run it with
# the same privilege that did the chown, or the counters below report 0 and the summary line lies.
# Tier is passed in, not read from a global: under `set -u` a global $TIER is unbound in the unlock
# and status branches, so a future call site there would abort on an undefined variable.
priv_chmod() { local t="$1"; shift; if [ "$t" = hardened ]; then sudo chmod "$@"; else chmod "$@"; fi; }

case "$CMD" in
  lock)
    # 1. Escalate FIRST so we know which tier we actually achieved.
    #    The tier is derived from the OBSERVED filesystem, never from chown's exit code. `chown -R`
    #    over several targets exits non-zero if ANY of them failed but does not roll back the ones
    #    that succeeded, so a half-success would otherwise leave TIER=degraded while core/ is
    #    already root-owned — and every message and state write below would then be false.
    #    stderr is captured, not discarded: a mistyped password, an aborted prompt and a
    #    not-in-sudoers user all produce the same silent non-zero, and reporting all three as
    #    "sudo unavailable" is exactly the dishonest degradation this kit exists to stop.
    TIER=degraded
    if have_sudo; then
      sudo_err="$(harden_targets | tr '\n' '\0' | xargs -0 sudo chown -R root 2>&1 >/dev/null)"
      [ "$(integrity_owner_uid "$KIT/core")" = "0" ] && TIER=hardened
    fi
    if [ "$TIER" != hardened ] && [ -n "${sudo_err:-}" ]; then
      echo "lock-kit: escalation failed — sudo said: $sudo_err" >&2
    fi
    # 2. Record the tier while the directory is still writable by SOMEONE.
    if [ "$TIER" = hardened ]; then
      printf '{"tier":"hardened","at":"%s"}\n' "$(date -u +%FT%TZ 2>/dev/null || echo '?')" \
        | sudo tee "$STATE" >/dev/null
    else
      write_state degraded \
        || echo "lock-kit: WARNING could not record the tier in $STATE — 'status' will report from ownership alone" >&2
    fi
    # Mirror the tier OUTSIDE the kit tree so a rename of the kit dir can be spotted. Best effort:
    # a project without a .claude/hooks/ (Cursor-only, or the engine used standalone) is not an error.
    #
    # Honest limit, stated plainly so nobody mistakes this for a tamper-proof record: .claude/hooks/
    # must stay user-writable (the pack installer writes its own hooks there without sudo), so
    # .flaky-kit-expect is deletable by exactly the same actor who can rename $KIT aside. This does
    # not close the residual harden_targets() documents above — it converts a silent single `mv`
    # into a two-step act, and it still catches the common accidental case (a rename/cleanup that
    # forgets to also scrub the expectation file). Detection, not prevention, and not un-defeatable.
    expect_root="$(git -C "$KIT" rev-parse --show-toplevel 2>/dev/null)"
    if [ -n "$expect_root" ] && [ -d "$expect_root/.claude/hooks" ]; then
      expect_tier="$(integrity_state "$KIT")"
      [ -n "$expect_tier" ] && printf '%s\n' "$expect_tier" > "$expect_root/.claude/hooks/.flaky-kit-expect" 2>/dev/null
    fi
    # 3. Only now remove the write bits — files first, then dirs.
    n=0; while IFS= read -r f; do priv_chmod "$TIER" a-w "$f" 2>/dev/null && n=$((n+1)); done < <(surface_files)
    d=0; while IFS= read -r p; do priv_chmod "$TIER" a-w "$p" 2>/dev/null && d=$((d+1)); done < <(surface_dirs)
    if [ "$TIER" = hardened ]; then
      echo "lock-kit: HARDENED $n files + $d dirs — the safety surface, including the kit root, is owned by root. Reopening needs a password; no write path inside this kit can reverse it." >&2
      echo "lock-kit: residual (by design, not a gap): the kit DIRECTORY can still be renamed aside via its own parent, which must stay user-owned so other skills can install there. That is detected, not prevented — see the gate's out-of-tree expectation." >&2
      echo "lock-kit: to edit, run:  HEKTOR_FLAKYKIT_UNLOCK=1 $0 unlock" >&2
    else
      echo "lock-kit: DEGRADED — locked $n files + $d dirs read-only, but the surface is still owned by $ME." >&2
      echo "lock-kit: that means the SAME user (and therefore an agent running as them) can chmod it back." >&2
      echo "lock-kit: for the real wall, re-run where sudo is available and the escalation is accepted." >&2
    fi ;;
  unlock)
    [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ] \
      || { echo "lock-kit: refusing unlock — set HEKTOR_FLAKYKIT_UNLOCK=1 (an agent's use of this flag is logged ONLY when a PreToolUse gate intercepts it; running this script directly, as you are now, is not recorded anywhere by this file. The PASSWORD below is the actual consent)" >&2; exit 77; }
    [ -n "$ME" ] && [ "$ME" != root ] \
      || { echo "lock-kit: refusing unlock — no invoking user to return ownership to (running as a direct root shell?). Re-run as the user who owns the project." >&2; exit 78; }
    if [ "$(integrity_owner_uid "$KIT/core")" = "0" ]; then
      harden_targets | tr '\n' '\0' | xargs -0 sudo chown -R "$ME" \
        || { echo "lock-kit: unlock aborted — chown back to $ME failed; the kit stays hardened" >&2; exit 77; }
    fi
    d=0; while IFS= read -r p; do chmod u+w "$p" && d=$((d+1)); done < <(surface_dirs)
    n=0; while IFS= read -r f; do chmod u+w "$f" && n=$((n+1)); done < <(surface_files)
    write_state unlocked \
      || echo "lock-kit: WARNING could not record the tier in $STATE — 'status' will report from ownership alone" >&2
    echo "lock-kit: UNLOCKED $n files + $d dirs for $ME. Re-lock when done:  $0 lock" >&2 ;;
  status)
    while IFS= read -r f; do
      if [ -w "$f" ]; then echo "  rw  ${f#"$KIT"/}"; else echo "  r-  ${f#"$KIT"/}"; fi
    done < <(surface_files)
    while IFS= read -r p; do
      label="${p#"$KIT"/}"; [ "$p" = "$KIT" ] && label="."
      if [ -w "$p" ]; then echo "  rw  $label/"; else echo "  r-  $label/"; fi
    done < <(surface_dirs)
    echo "  tier: $(integrity_tier "$(integrity_owner_uid "$KIT/core")" "$(integrity_state "$KIT")")" ;;
  *) echo "usage: lock-kit.sh lock|unlock|status" >&2; exit 64 ;;
esac
