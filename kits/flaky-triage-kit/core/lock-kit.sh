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

case "$CMD" in
  lock)
    n=0; while IFS= read -r f; do chmod a-w "$f" && n=$((n+1)); done < <(surface_files)
    d=0; while IFS= read -r p; do chmod a-w "$p" && d=$((d+1)); done < <(surface_dirs)
    echo "lock-kit: LOCKED $n files + $d dirs (read-only). Edit/Write/Bash writes, deletes, renames, and new-file creation on the surface now fail at the OS layer." >&2
    echo "lock-kit: to edit, run:  HEKTOR_FLAKYKIT_UNLOCK=1 $0 unlock" >&2 ;;
  unlock)
    [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ] \
      || { echo "lock-kit: refusing unlock — set HEKTOR_FLAKYKIT_UNLOCK=1 (human consent)" >&2; exit 77; }
    d=0; while IFS= read -r p; do chmod u+w "$p" && d=$((d+1)); done < <(surface_dirs)
    n=0; while IFS= read -r f; do chmod u+w "$f" && n=$((n+1)); done < <(surface_files)
    echo "lock-kit: UNLOCKED $n files + $d dirs for the owner." >&2 ;;
  status)
    while IFS= read -r f; do
      if [ -w "$f" ]; then echo "  rw  ${f#"$KIT"/}"; else echo "  r-  ${f#"$KIT"/}"; fi
    done < <(surface_files)
    while IFS= read -r p; do
      label="${p#"$KIT"/}"; [ "$p" = "$KIT" ] && label="."
      if [ -w "$p" ]; then echo "  rw  $label/"; else echo "  r-  $label/"; fi
    done < <(surface_dirs) ;;
  *) echo "usage: lock-kit.sh lock|unlock|status" >&2; exit 64 ;;
esac
