#!/bin/bash
# core/_integrity.sh — is this tree still the tree that was locked?
#
# WHY: core/lock-kit.sh can now establish a HARDENED tier (core/** owned by root, so only a
# password-gated sudo can reopen it) or fall back to a DEGRADED tier (chmod a-w only, which the
# owning user — and therefore the agent — can always reverse). A kit that silently slipped from the
# first to the second would still LOOK locked while enforcing nothing. Source this and ask.
#
# LIMIT, stated up front: this check lives INSIDE the tree it validates, so it cannot detect
# SHADOWING (`mv` the kit dir aside and put a fake one in its place) — a shadowed tree carries its
# own state file and is indistinguishable from a fresh un-hardened install. That case is the
# relocated gate's job (.claude/hooks/, outside the shadowable tree). This check catches ACCIDENTS:
# an upgrade that dropped ownership, a kit installed but never hardened, a maintenance unlock left
# open. Two different jobs, deliberately not conflated.
#
# Never wedges a caller: every function returns 0 and prints its answer, mirroring hektor_audit's
# "a broken check must not break the run" discipline.

# integrity_owner_uid <path> -> numeric uid, or empty. BSD and GNU stat take different flags.
integrity_owner_uid() {
  local p="$1"
  [ -e "$p" ] || return 0
  case "$(uname -s 2>/dev/null)" in
    Darwin|*BSD) stat -f %u "$p" 2>/dev/null ;;
    *)           stat -c %u "$p" 2>/dev/null ;;
  esac
}

# integrity_state <kit_root> -> the recorded tier, or empty when absent/unreadable.
integrity_state() {
  local f="$1/core/.lock-state"
  [ -r "$f" ] || return 0
  sed -n 's/.*"tier"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$f" 2>/dev/null | head -1
}

# integrity_tier <owner_uid> <recorded_tier> -> hardened|unlocked|degraded|mismatch|stale
# Ranks protection: root-owned is 2, anything else is 1; a recorded "hardened" expects 2, all else 1.
# Weaker-than-recorded is the dangerous direction and is the only one that yields `mismatch`.
integrity_tier() {
  local owner="${1:-}" recorded="${2:-}" actual=1 expected=1
  [ "$owner" = "0" ] && actual=2
  [ "$recorded" = "hardened" ] && expected=2
  if [ "$actual" -lt "$expected" ]; then echo mismatch; return 0; fi
  if [ "$actual" -gt "$expected" ]; then echo stale; return 0; fi
  case "$recorded" in
    hardened|unlocked|degraded) echo "$recorded" ;;
    *)                          echo degraded ;;
  esac
  return 0
}
