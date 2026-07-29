#!/bin/bash
# core/lock-kit.sh — establishes the strongest OS-level protection tier it can on the kit's safety
# surface: hardened (root-owned, password-gated reopen) when possible, else a chmod read-only bit.
# See TIERS below — naming only "a read-only bit" here would describe the weaker, reversible tier.
#
# WHY
# ---
# The PreToolUse self-protection gate (`<project>/.claude/hooks/flaky-kit-self-protection-gate.sh` —
# relocated OUT of the kit tree so a rename cannot take the detector along with it) is the first
# line, but it is policy: it only bites where the CLI honors a `deny`, and a Bash command is matched
# only heuristically. What the OS enforces for EVERY writer — Edit/Write tool, Bash `>`/`sed -i`, an
# injected script, a compiled helper — is FILE OWNERSHIP: `chmod` requires it, so a root-owned surface
# cannot be reopened by the account the agent runs as.
#
# Careful with the previous sentence, because an earlier version of it got this wrong: what closes the
# gap is root OWNERSHIP, not "a filesystem read-only bit". This header used to say the read-only bit
# "is the wall the gate is not" while its own TIERS block, eighteen lines down, correctly called that
# same bit friction — a same-user `chmod u+w` reverses it. Only the HARDENED tier is a wall.
#
# Round2 (dirs, not just files): `chmod a-w` on FILES alone left a hole — deleting or renaming a
# file, and creating a brand-new one, are governed by the PARENT DIRECTORY's write bit, not the
# file's own. `cd core && rm apply.sh && printf >apply.sh` (and `echo x >core/new.json`) both
# succeeded on a "locked" kit for exactly this reason. Fixed by ALSO `chmod a-w`-ing every directory
# under core/ (recursively — nested dirs like core/tests/, core/capture-res/** need the same
# treatment, not just the top-level core/) plus the kit root itself (so `core`/`SKILL.md` can't be
# renamed/deleted/shadowed out from under the lock either), and an in-tree `hooks/` on installs that
# predate the gate's relocation — see the note above surface_files().
#
# TIERS. `lock` establishes the strongest tier it can:
#   hardened — the safety surface is owned by ROOT: core/**, SKILL.md, both harnesses' gate scripts
#              and vendored libs, and the kit root directory itself. chmod requires OWNERSHIP, so the
#              agent (running as you)
#              cannot reverse it; reopening needs sudo, which needs a password only a human at the
#              keyboard can supply. THAT password is the human consent — provided no cached sudo
#              credential short-circuits the prompt, which is why both privileged sections below end
#              with `sudo -k` (item 5). HEKTOR_FLAKYKIT_UNLOCK is not consent —
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
# "keyed to human consent" — both retracted — and declared a shell-capable agent running as the file
# owner "out of scope". That agent is precisely what this kit constrains, and it defeated the lock with
# one documented command. The claims are corrected rather than deleted, so the mistake stays legible.
#
# STILL NOT COVERED — the full list, because a partial one is how the last overclaim happened:
#   1. Shadowing. `mv` the kit dir aside and replace it. rename() is governed by the PARENT
#      directory, and $KIT's parent must stay user-writable so other skills can install there.
#      DETECTED via the gate's out-of-tree record, not prevented. That detector now tests the kit's
#      PROTECTION (is core/ still root-owned?) rather than merely its PRESENCE, so a
#      rename-AND-replace — the case its own warning text has always described — is caught too, not
#      only a rename that leaves a hole where the kit used to be.
#   2. That record is itself deletable. Its directory stays user-owned (the pack installer writes
#      its own hooks there without sudo), so the same actor who renames the kit can erase the
#      expectation in the same breath. Chowning that directory WOULD close this; the decision not
#      to rests on the standing cost of routing every future pack-hook update through sudo, NOT on
#      any claim that it would not help. It would. The gates do now count that record — and the
#      `.claude/hooks` / `.cursor/hooks` directories themselves, as operands — as matched surface,
#      so erasing it is denied-and-audited wherever a gate runs. That is friction, not the
#      ownership this item is about.
#   3. Every surface path that lives OUTSIDE $KIT has the same shape: the two gate scripts and the
#      vendored libs ARE chowned to root, so they cannot be EDITED, but their parent directories
#      must stay user-owned for exactly the reason in item 2 — so they can still be renamed aside
#      and replaced without a password. Protection against edit, not against replacement. The
#      HARDENED banner says so rather than letting "the safety surface is owned by root" be read as
#      covering it.
#   4. Social engineering a human into running the unlock.
#   5. Anything after the password is typed — keep the maintenance window short. `lock` and `unlock`
#      now end their privileged sections with `sudo -k`, because sudo's default
#      `timestamp_timeout=5` otherwise leaves a ~5-minute window in which ANY process running as
#      this user — including the agent this kit constrains — can re-run the unlock, or a bare
#      `sudo chown -R $(id -un) <kit>`, with NO prompt, and can DETECT that window with
#      `sudo -n true`. So "reopening needs a password" was not unconditional: the lock itself opened
#      the hole. Residual after `sudo -k`: the window between the password prompt and the end of the
#      privileged section, plus any other `sudo` the user runs afterwards for their own reasons.
#   6. Partial hardening. A `chown` over several operands can succeed on some and fail on others,
#      and the tier is sampled from core/ alone — so core/ root-owned with $KIT (or a gate script)
#      still user-owned is reported as `hardened`. That case is now ANNOUNCED (sudo's own words are
#      printed whenever it said anything at all, and the banner derives its kit-root clause from the
#      kit root's ACTUAL owner) and DIAGNOSABLE (`status` prints an owner per path). It is not
#      prevented; re-running `lock` is the fix.
#
# Closed since this list was first written, recorded here so the change stays legible instead of
# quietly vanishing: `core/shell-guard.py` honoured `HEKTOR_FK_SURFACE` by REPLACING its surface
# pattern wholesale, so any value matching nothing (`HEKTOR_FK_SURFACE=/definitely/nowhere`) turned
# the primary Bash decision path into an unconditional ALLOW. The override is now ADDITIVE: it can
# add a root, it cannot remove the default surface.
#
# Reversible + git-clean: this toggles only the WRITE bit (`a-w` / `u+w`); it keeps the execute bit
# (dirs need it to stay traversable, scripts need it to stay runnable), so git sees no
# 100644<->100755 mode flip. It never touches file/dir CONTENT.
#
# Usage:  core/lock-kit.sh lock      # tries `sudo chown -R root` on the safety surface, plus a
#                                    # separate NON-recursive `chown root` on the kit root (see
#                                    # harden_root() for why they must not share one call) — may
#                                    # prompt for a password; success reaches the HARDENED tier
#                                    # (password-gated reopen). Without sudo — or with it refused —
#                                    # it DEGRADES to the old chmod-a-w-only behaviour and says so
#                                    # loudly. HEKTOR_FK_NO_SUDO=1 forces the degraded path on purpose
#                                    # (used by the test suite and by anyone who wants the old
#                                    # behaviour without being prompted).
#         core/lock-kit.sh unlock    # chown back to the invoking user (if hardened) + chmod u+w —
#                                    # requires HEKTOR_FLAKYKIT_UNLOCK=1
#         core/lock-kit.sh status    # per-path writability AND OWNER for every surface path (incl.
#                                    # the out-of-tree gate scripts/libs) + the effective tier. The
#                                    # owner column is the only way to tell a root-owned path from a
#                                    # user-owned `a-w` one — `[ -w ]` is false for both.
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
# anyone who wants the old behaviour). We probe only for the BINARY and let the real call prompt,
# because a password prompt is exactly what we want when the user is present.
#
# Deliberately NOT probed with `sudo -n true`: that succeeds only when a credential is already
# cached, and a cached credential is not the convenience it looks like here. It is a capability this
# process shares with every other process running as this user — including the agent this kit
# constrains, which can probe for the window with the very same `sudo -n true` and reopen the kit
# inside it with no prompt at all. Treating "we already have the credential" as a reason to skip the
# prompt would therefore hand the agent the asymmetry the hardened tier exists to create. Hence both
# privileged sections below end with `sudo -k` (header item 5).
have_sudo() { [ "${HEKTOR_FK_NO_SUDO:-0}" = "1" ] && return 1; command -v sudo >/dev/null 2>&1; }
write_state() { printf '{"tier":"%s","at":"%s"}\n' "$1" "$(date -u +%FT%TZ 2>/dev/null || echo '?')" > "$STATE" 2>/dev/null; }

# Mirror the tier OUTSIDE the kit tree so a rename of the kit dir can be spotted. Best effort: a
# project without a .claude/hooks/ (Cursor-only, or the engine used standalone) is not an error.
#
# Honest limit, stated plainly so nobody mistakes this for a tamper-proof record: .claude/hooks/
# must stay user-writable (the pack installer writes its own hooks there without sudo), so
# .flaky-kit-expect is deletable by exactly the same actor who can rename $KIT aside. This does not
# close the residual header items 1-3 document — it converts a silent single `mv` into a two-step
# act, and it still catches the common accidental case (a rename/cleanup that forgets to also scrub
# the expectation file). Detection, not prevention, and not un-defeatable.
#
# Called by BOTH `lock` and `unlock`, and `unlock` calling it is not symmetry for its own sake. The
# gates' shadow check fires on "recorded hardened + core/ no longer root-owned" — which is precisely
# the state a LEGITIMATE maintenance window puts the tree in. An unlock that left the record saying
# `hardened` would therefore make every open maintenance window look like a shadowed kit, and a
# warning that cries wolf on the normal path is a warning nobody reads. The cost, stated rather than
# hidden: while the record says `unlocked` the shadow check is silent — during a maintenance window
# there is no protection left to have lost. Keep the window short (header item 5).
write_expect() {
  local root; root="$(git -C "$KIT" rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$root" ] && [ -d "$root/.claude/hooks" ] || return 0
  printf '%s\n' "$1" > "$root/.claude/hooks/.flaky-kit-expect" 2>/dev/null
  return 0
}

# The safety surface: all of core/ (logic + config + capture sources), the skill prompt, and — only
# for a kit installed BEFORE the gate was relocated out of the tree — the in-tree `hooks/` directory
# that such an install still carries.
#
# WHY $KIT/hooks is still listed, since `install.sh` no longer creates it (and now deletes a stale
# one on upgrade), so on a current install these `find`s print nothing: `lock` can be run on a
# pre-relocation tree that has NOT been re-installed yet, and that tree holds a REAL gate script.
# Dropping the branches would leave it user-writable while the banner below announced that the safety
# surface is owned by root — exactly the kind of claim this file's header exists to retract. Kept as
# explicit upgrade-path handling, not as an oversight; the cost is one `find` over a path that
# usually does not exist. The lock-tier test fixture creates it on purpose for the same reason and
# says so.
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

# Everything that must be root-owned in the hardened tier, EXCEPT the kit root itself — that one is
# chowned separately and non-recursively, see the block below this function for why.
#
# `chown -R` handles core/ (and a pre-relocation `hooks/`, see the note above surface_files())
# recursively; SKILL.md, BOTH harnesses' gate scripts and the vendored libs are single files. Those
# live OUTSIDE $KIT by design so a rename of the kit dir cannot take them along — which is exactly
# why they are listed one by one.
#
# BOTH gates and BOTH audit libs, not just the Claude gate: `install.sh` installs the Cursor gate
# whenever `--harness` includes cursor, and `SURF_RE`, `core/shell-guard.py`'s `SURF`, the CODEOWNERS
# block and `README.md` all declare the Cursor gate, the Cursor libs and `.claude/hooks/lib/audit.sh`
# part of the safety surface. Leaving them out meant a Cursor user could run `lock`, read "the safety
# surface … is owned by root", and still have their only gate — plus the audit lib that records the
# unlock — plainly user-writable. Header item 3 states precisely what root-owning these FILES does
# and does not buy, because their parents stay user-owned.
harden_targets() {
  printf '%s\n' "$KIT/core"
  [ -d "$KIT/hooks" ] && printf '%s\n' "$KIT/hooks"
  [ -f "$KIT/SKILL.md" ] && printf '%s\n' "$KIT/SKILL.md"
  local root p; root="$(git -C "$KIT" rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$root" ]; then
    for p in .claude/hooks/flaky-kit-self-protection-gate.sh \
             .claude/hooks/lib/audit.sh \
             .cursor/hooks/flaky-kit-self-protection-gate.sh \
             .cursor/hooks/lib/cursor-compat.sh \
             .cursor/hooks/lib/audit.sh; do
      [ -f "$root/$p" ] && printf '%s\n' "$root/$p"
    done
  fi
  return 0
}

# The kit ROOT: chowned, but by its own call and WITHOUT -R. Both halves are load-bearing.
#
# WHY it is chowned at all: `rename()` is governed by the write+execute bits of the PARENT directory,
# never by the target's own bits or ownership — so with $KIT owned by the invoking user,
# `chmod u+w "$KIT"` (which succeeds, because that user owns it) followed by
# `mv "$KIT/core" "$KIT/core.bak" && mkdir "$KIT/core"` swaps in an attacker-controlled core/ without
# touching one root-owned file and without a password. Chowning only core/ therefore reduces the
# hardened tier to a two-command bypass. Root-owning the kit root closes it.
#
# WHY NOT in the same `chown -R` call as the surface: `-R` applies to EVERY operand. An earlier
# version listed $KIT alongside the surface while its comment claimed the entry was
# "non-recursively-meaningful" — it was not; `-R` recursed the whole kit tree. Harmless in an
# INSTALLED kit, where core/ + SKILL.md ARE the tree, but not in the SOURCE checkout that the release
# flow re-locks after merge: `adapters/`, `install.sh`, `kernel.md`, `README.md` and `scripts/` are
# all git-tracked there and would silently become root-owned. One plain `chown` gives the DIRECTORY
# ENTRY to root, which is all the paragraph above needs.
#
# What this still does NOT close, and the HARDENED message must not claim it does: $KIT's own parent
# (.claude/skills/) has to stay user-owned, because every other skill installs there — so $KIT itself
# can be renamed aside by the same trick one level up. That residual is the design's accepted one and
# is what the relocated gate's out-of-tree expectation detects.
harden_root() { printf '%s\n' "$KIT"; }

# In the hardened tier the surface belongs to root, so THIS user's chmod would fail — run it with
# the same privilege that did the chown, or the counters below report 0 and the summary line lies.
# Tier is passed in, not read from a global: under `set -u` a global $TIER is unbound in the unlock
# and status branches, so a future call site there would abort on an undefined variable.
priv_chmod() { local t="$1"; shift; if [ "$t" = hardened ]; then sudo chmod "$@"; else chmod "$@"; fi; }

# The owner NAME of a path, for `status`. Not in _integrity.sh: the tier logic compares uids (0 vs
# not-0) and never needs a name, while a human diagnosing a partial `chown` needs to see who owns
# what. Same BSD/GNU `stat` branch as integrity_owner_uid; falls back to the uid, then to `?`.
owner_name() {
  local n
  case "$(uname -s 2>/dev/null)" in
    Darwin|*BSD) n="$(stat -f %Su "$1" 2>/dev/null)" ;;
    *)           n="$(stat -c %U  "$1" 2>/dev/null)" ;;
  esac
  [ -n "$n" ] || n="$(integrity_owner_uid "$1")"
  printf '%s' "${n:-?}"
  return 0
}

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
      # Two calls, not one: `-R` for the surface, plain for the kit root. See harden_root() for why
      # putting $KIT in the recursive call is destructive in the source checkout.
      sudo_err="$(harden_targets | tr '\n' '\0' | xargs -0 sudo chown -R root 2>&1 >/dev/null)"
      root_err="$(sudo chown root "$(harden_root)" 2>&1 >/dev/null)"
      [ -n "$root_err" ] && sudo_err="${sudo_err:+$sudo_err; }$root_err"
      [ "$(integrity_owner_uid "$KIT/core")" = "0" ] && TIER=hardened
    fi
    # Print sudo's own words whenever it produced any — NOT only when the tier came out degraded.
    # Gating this on `TIER != hardened` (the earlier behaviour) hid the PARTIAL case precisely: a
    # `chown` that roots core/ but fails on $KIT, on a gate script, or on an audit lib still sets
    # TIER=hardened, so the single explanation of what went wrong was swallowed and the banner below
    # then asserted something false. A safety tool must not eat the error that says it is only
    # half-applied.
    if [ -n "${sudo_err:-}" ]; then
      echo "lock-kit: escalation reported errors — sudo said: $sudo_err" >&2
      [ "$TIER" = hardened ] \
        && echo "lock-kit: the tier reached is therefore PARTIAL — core/ is root-owned but at least one other surface path is not. Run '$0 status' to see the owner of every path, fix the cause, then re-run '$0 lock'." >&2
    fi
    # 2. Record the tier while the directory is still writable by SOMEONE.
    if [ "$TIER" = hardened ]; then
      printf '{"tier":"hardened","at":"%s"}\n' "$(date -u +%FT%TZ 2>/dev/null || echo '?')" \
        | sudo tee "$STATE" >/dev/null
    else
      write_state degraded \
        || echo "lock-kit: WARNING could not record the tier in $STATE — 'status' will report from ownership alone" >&2
    fi
    # Mirror the tier OUTSIDE the kit tree so a rename of the kit dir can be spotted — the TIER we
    # actually achieved, not a value read back out of the state file (a failed state write must not
    # silently skip the out-of-tree record too). See write_expect() for the honest limits.
    write_expect "$TIER"
    # 3. Only now remove the write bits — files first, then dirs.
    n=0; while IFS= read -r f; do priv_chmod "$TIER" a-w "$f" 2>/dev/null && n=$((n+1)); done < <(surface_files)
    d=0; while IFS= read -r p; do priv_chmod "$TIER" a-w "$p" 2>/dev/null && d=$((d+1)); done < <(surface_dirs)
    # 4. Drop the credential this run just cached — the privileged section is over. Header item 5:
    #    without this, sudo's default timestamp_timeout leaves a ~5-minute no-prompt reopen window
    #    that THIS command created, detectable by the agent with `sudo -n true`.
    [ "$TIER" = hardened ] && { sudo -k 2>/dev/null || true; }
    if [ "$TIER" = hardened ]; then
      # The kit-root clause is DERIVED from the kit root's real owner, never assumed: a chown that
      # rooted core/ and failed on $KIT lands here too, and printing "including the kit root" then
      # would be false — the same class of defect as the "REAL wall" claims this header retracts.
      if [ "$(integrity_owner_uid "$KIT")" = "0" ]; then
        echo "lock-kit: HARDENED $n files + $d dirs — the safety surface, including the kit root, is owned by root. Reopening needs a password; no write path inside this kit can reverse it." >&2
      else
        echo "lock-kit: HARDENED (PARTIAL) $n files + $d dirs — core/ is owned by root, but the kit root itself ($KIT) is still owned by ${ME:-this user}. That is NOT a complete wall: its owner can 'chmod u+w' it and rename core/ aside with no password. Re-run '$0 lock'; '$0 status' shows the owner of every surface path." >&2
      fi
      echo "lock-kit: residual (by design, not a gap): the kit DIRECTORY can still be renamed aside via its own parent, which must stay user-owned so other skills can install there. That is detected, not prevented — see the gate's out-of-tree expectation." >&2
      echo "lock-kit: residual (same shape): the gate scripts and vendored libs OUTSIDE this kit are root-owned so they cannot be EDITED, but their parent directories must stay user-owned — so they too can be renamed aside and replaced. Protection against edit, not against replacement." >&2
      echo "lock-kit: to edit, run:  HEKTOR_FLAKYKIT_UNLOCK=1 $0 unlock" >&2
    else
      echo "lock-kit: DEGRADED — locked $n files + $d dirs read-only, but core/ is still owned by $ME." >&2
      echo "lock-kit: that means the SAME user (and therefore an agent running as them) can chmod it back." >&2
      # The mirror image of the PARTIAL case above, and the same defect if left unsaid: `chown -R` over
      # several operands can succeed on some while failing on core/, which lands here — TIER=degraded
      # with parts of the surface root-owned. A blanket "the surface is still owned by $ME" would then be
      # false, so the claim above is narrowed to core/ (which the tier really is sampled from) and the
      # uneven case gets named instead of averaged away.
      part=0
      while IFS= read -r t; do
        [ "$(integrity_owner_uid "$t")" = "0" ] && { part=1; break; }
      done < <({ harden_targets; harden_root; })
      [ "$part" = "1" ] \
        && echo "lock-kit: NOTE the escalation applied UNEVENLY — some surface paths ARE root-owned even though core/ is not, so this is neither tier cleanly. '$0 status' shows which paths; 'HEKTOR_FLAKYKIT_UNLOCK=1 $0 unlock' hands them back, then re-run '$0 lock'." >&2
      echo "lock-kit: for the HARDENED tier (root-owned surface, password-gated reopen), re-run where sudo is available and the escalation is accepted." >&2
    fi ;;
  unlock)
    [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ] \
      || { echo "lock-kit: refusing unlock — set HEKTOR_FLAKYKIT_UNLOCK=1 (an agent's use of this flag is logged ONLY when a PreToolUse gate intercepts it; running this script directly, as you are now, is not recorded anywhere by this file. The PASSWORD below is the actual consent)" >&2; exit 77; }
    [ -n "$ME" ] && [ "$ME" != root ] \
      || { echo "lock-kit: refusing unlock — no invoking user to return ownership to (running as a direct root shell?). Re-run as the user who owns the project." >&2; exit 78; }
    # Hand ownership back when ANY surface path is root-owned — not just core/. Gating the chown-back
    # on core/ alone meant a PARTIALLY hardened tree had no supported way to reopen: with core/
    # user-owned but $KIT root-owned, this branch was skipped and the `chmod u+w "$KIT"` below then
    # failed, so neither `lock` nor `unlock` could put the tree back; and with core/ rooted but a gate
    # script not, the reverse left a root-owned script behind under an "UNLOCKED" banner. Sample every
    # target, stop at the first root-owned hit.
    hardened_any=0
    while IFS= read -r t; do
      [ "$(integrity_owner_uid "$t")" = "0" ] && { hardened_any=1; break; }
    done < <({ harden_targets; harden_root; })
    if [ "$hardened_any" = "1" ]; then
      # Same split as `lock`, for the same reason (harden_root(): -R applies to every operand).
      harden_targets | tr '\n' '\0' | xargs -0 sudo chown -R "$ME" \
        || { echo "lock-kit: unlock aborted — chown back to $ME failed; the kit stays hardened" >&2; exit 77; }
      sudo chown "$ME" "$(harden_root)" \
        || { echo "lock-kit: unlock aborted — chown of the kit root back to $ME failed; the kit stays hardened" >&2; exit 77; }
    fi
    d=0; while IFS= read -r p; do chmod u+w "$p" && d=$((d+1)); done < <(surface_dirs)
    n=0; while IFS= read -r f; do chmod u+w "$f" && n=$((n+1)); done < <(surface_files)
    write_state unlocked \
      || echo "lock-kit: WARNING could not record the tier in $STATE — 'status' will report from ownership alone" >&2
    # Refresh the OUT-OF-TREE record too. `lock` writes it and `unlock` must as well: the gates'
    # shadow check fires on "recorded hardened + core/ not root-owned", which is exactly what a
    # maintenance window looks like, so leaving the record at `hardened` would make every legitimate
    # unlock indistinguishable from a shadowed kit. See write_expect().
    write_expect unlocked
    # The privileged section is over — drop the credential (header item 5).
    [ "$hardened_any" = "1" ] && { sudo -k 2>/dev/null || true; }
    echo "lock-kit: UNLOCKED $n files + $d dirs for $ME. Re-lock when done:  $0 lock" >&2 ;;
  status)
    # An OWNER column, not just a writability bit. `[ -w ]` is false for a root-owned path AND for a
    # user-owned one with `a-w`, so writability alone cannot tell the hardened tier from the degraded
    # one, and cannot show WHICH paths a partial `chown` missed — the one thing you need in order to
    # fix it. Spec §6 asked for per-path reporting for exactly that case; per-path writability did not
    # deliver it.
    report() { local m=r-; [ -w "$1" ] && m=rw; printf '  %s  %s  owner=%s\n' "$m" "$2" "$(owner_name "$1")"; }
    while IFS= read -r f; do report "$f" "${f#"$KIT"/}"; done < <(surface_files)
    while IFS= read -r p; do
      label="${p#"$KIT"/}"; [ "$p" = "$KIT" ] && label="."
      report "$p" "$label/"
    done < <(surface_dirs)
    # The OUT-OF-TREE surface as well — a Cursor user's only gate and the audit libs are hardened
    # targets that live outside $KIT and would otherwise never show up here at all.
    while IFS= read -r p; do
      case "$p" in "$KIT"|"$KIT"/*) continue ;; esac
      report "$p" "$p"
    done < <(harden_targets)
    echo "  tier: $(integrity_tier "$(integrity_owner_uid "$KIT/core")" "$(integrity_state "$KIT")")" ;;
  *) echo "usage: lock-kit.sh lock|unlock|status" >&2; exit 64 ;;
esac
