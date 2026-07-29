#!/bin/bash
# core/lock-kit.sh — put a REAL OS-level wall (read-only bit) around the kit's safety surface.
#
# WHY
# ---
# The PreToolUse self-protection gate (`../hooks/flaky-kit-self-protection-gate.sh`) is the first
# line, but it is policy: it only bites where the CLI honors a `deny`, and a Bash redirect is
# matched only heuristically. A filesystem read-only bit is enforced by the OS for EVERY writer —
# Edit/Write tool, Bash `>`/`sed -i`, an injected script — so it is the wall the gate is not.
# It is keyed to human consent: `unlock` requires HEKTOR_FLAKYKIT_UNLOCK=1, the same flag the gate uses.
#
# Round2 (dirs, not just files): `chmod a-w` on FILES alone left a hole — deleting or renaming a
# file, and creating a brand-new one, are governed by the PARENT DIRECTORY's write bit, not the
# file's own. `cd core && rm apply.sh && printf >apply.sh` (and `echo x >core/new.json`) both
# succeeded on a "locked" kit for exactly this reason. Fixed by ALSO `chmod a-w`-ing every directory
# under core/ + hooks/ (recursively — nested dirs like core/tests/, core/capture-res/** need the
# same wall, not just the top-level core/) plus the kit root itself (so `core`/`hooks`/`SKILL.md`
# can't be renamed/deleted/shadowed out from under the lock either). This is still
# defense-in-depth, not an impregnable wall: a shell-capable agent with a way to re-exec as the
# file owner, or a tool that ignores POSIX permissions entirely, is out of scope — the goal is to
# close the NATURAL, single-command, accidental/self-defeating bypass, not to stop a determined
# privileged attacker.
#
# Reversible + git-clean: this toggles only the WRITE bit (`a-w` / `u+w`); it keeps the execute bit
# (dirs need it to stay traversable, scripts need it to stay runnable), so git sees no
# 100644<->100755 mode flip. It never touches file/dir CONTENT.
#
# Usage:  core/lock-kit.sh lock      # chmod a-w the surface — writes then fail at the OS layer
#         core/lock-kit.sh unlock    # chmod u+w the surface — requires HEKTOR_FLAKYKIT_UNLOCK=1
#         core/lock-kit.sh status    # show writability of each surface file/dir
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # .../hektor-flaky-triage/core
KIT="$(cd "$HERE/.." && pwd)"                            # .../hektor-flaky-triage
CMD="${1:-}"

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
  [ -f "$KIT/SKILL.md" ] && printf '%s\n' "$KIT/SKILL.md"
  local g; g="$(git -C "$KIT" rev-parse --show-toplevel 2>/dev/null)/.claude/hooks/flaky-kit-self-protection-gate.sh"
  [ -f "$g" ] && printf '%s\n' "$g"
  return 0
}
# In the hardened tier the surface belongs to root, so THIS user's chmod would fail — run it with
# the same privilege that did the chown, or the counters below report 0 and the summary line lies.
priv_chmod() { if [ "$TIER" = hardened ]; then sudo chmod "$@"; else chmod "$@"; fi; }

case "$CMD" in
  lock)
    # 1. Escalate FIRST so we know which tier we actually achieved.
    TIER=degraded
    if have_sudo; then
      targets="$(harden_targets)"
      # One sudo call for the whole surface: credentials are cached after it, so the chmods below
      # do not re-prompt, and the user types their password exactly once.
      printf '%s\n' "$targets" | tr '\n' '\0' | xargs -0 sudo chown -R root 2>/dev/null && TIER=hardened
    fi
    # 2. Record the tier while the directory is still writable by SOMEONE.
    if [ "$TIER" = hardened ]; then
      printf '{"tier":"hardened","at":"%s"}\n' "$(date -u +%FT%TZ 2>/dev/null || echo '?')" \
        | sudo tee "$STATE" >/dev/null
    else
      write_state degraded
    fi
    # 3. Only now remove the write bits — files first, then dirs.
    n=0; while IFS= read -r f; do priv_chmod a-w "$f" 2>/dev/null && n=$((n+1)); done < <(surface_files)
    d=0; while IFS= read -r p; do priv_chmod a-w "$p" 2>/dev/null && d=$((d+1)); done < <(surface_dirs)
    if [ "$TIER" = hardened ]; then
      echo "lock-kit: HARDENED $n files + $d dirs — the safety surface is owned by root. Reopening needs a password; no in-process write path can reverse it." >&2
      echo "lock-kit: to edit, run:  HEKTOR_FLAKYKIT_UNLOCK=1 $0 unlock" >&2
    else
      echo "lock-kit: DEGRADED — locked $n files + $d dirs read-only, but the surface is still owned by $ME." >&2
      echo "lock-kit: that means the SAME user (and therefore an agent running as them) can chmod it back." >&2
      echo "lock-kit: for the real wall, re-run on a machine where sudo is available." >&2
    fi ;;
  unlock)
    [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ] \
      || { echo "lock-kit: refusing unlock — set HEKTOR_FLAKYKIT_UNLOCK=1 (records intent in the audit log; the PASSWORD below is the actual consent)" >&2; exit 77; }
    [ -n "$ME" ] && [ "$ME" != root ] \
      || { echo "lock-kit: refusing unlock — no invoking user to return ownership to (running as a direct root shell?). Re-run as the user who owns the project." >&2; exit 78; }
    if [ "$(integrity_owner_uid "$KIT/core")" = "0" ]; then
      printf '%s\n' "$(harden_targets)" | tr '\n' '\0' | xargs -0 sudo chown -R "$ME" \
        || { echo "lock-kit: unlock aborted — chown back to $ME failed; the kit stays hardened" >&2; exit 77; }
    fi
    d=0; while IFS= read -r p; do chmod u+w "$p" && d=$((d+1)); done < <(surface_dirs)
    n=0; while IFS= read -r f; do chmod u+w "$f" && n=$((n+1)); done < <(surface_files)
    write_state unlocked
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
