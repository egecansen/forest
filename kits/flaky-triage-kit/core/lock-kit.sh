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
# Reversible + git-clean: this toggles only the WRITE bit (`a-w` / `u+w`); it keeps the execute bit, so
# scripts stay runnable AND git sees no 100644<->100755 mode flip. It never touches file CONTENT.
#
# Usage:  core/lock-kit.sh lock      # chmod a-w the surface — writes then fail at the OS layer
#         core/lock-kit.sh unlock    # chmod u+w the surface — requires HEKTOR_FLAKYKIT_UNLOCK=1
#         core/lock-kit.sh status    # show writability of each surface file
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # .../hektor-flaky-triage/core
KIT="$(cd "$HERE/.." && pwd)"                            # .../hektor-flaky-triage
CMD="${1:-}"

# The safety surface: all of core/ (logic + config + capture sources), the protection hook(s), the skill prompt.
surface() {
  find "$KIT/core"  -type f -print 2>/dev/null
  find "$KIT/hooks" -type f -print 2>/dev/null
  [ -f "$KIT/SKILL.md" ] && printf '%s\n' "$KIT/SKILL.md"
}

case "$CMD" in
  lock)
    n=0; while IFS= read -r f; do chmod a-w "$f" && n=$((n+1)); done < <(surface)
    echo "lock-kit: LOCKED $n files (read-only). Edit/Write/Bash writes now fail at the OS layer." >&2
    echo "lock-kit: to edit, run:  HEKTOR_FLAKYKIT_UNLOCK=1 $0 unlock" >&2 ;;
  unlock)
    [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ] \
      || { echo "lock-kit: refusing unlock — set HEKTOR_FLAKYKIT_UNLOCK=1 (human consent)" >&2; exit 77; }
    n=0; while IFS= read -r f; do chmod u+w "$f" && n=$((n+1)); done < <(surface)
    echo "lock-kit: UNLOCKED $n files for the owner." >&2 ;;
  status)
    while IFS= read -r f; do
      if [ -w "$f" ]; then echo "  rw  ${f#"$KIT"/}"; else echo "  r-  ${f#"$KIT"/}"; fi
    done < <(surface) ;;
  *) echo "usage: lock-kit.sh lock|unlock|status" >&2; exit 64 ;;
esac
