#!/bin/bash
# audit.sh — shared best-effort audit logger for Hektor hooks (Cursor port).
#
# Sourced by hooks to record security-relevant events (chiefly env-bypass use)
# to docs/hektor/.hook-audit.log. Never fails the caller: any error in resolving
# the repo root, the dir, the timestamp, or the append is swallowed.
#
# Identical to .claude/hooks/lib/audit.sh — the audit log path (docs/hektor/)
# is shared across both harnesses so bypass use is recorded in one place.
#
# Usage in a hook:
#   _LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
#   if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi
#   ...
#   hektor_audit "commit-gate bypassed (HEKTOR_COMMIT_GATE=off)"

hektor_audit() {
  local msg="$1" root log
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  [ -d "$root/docs/hektor" ] || return 0
  log="$root/docs/hektor/.hook-audit.log"
  printf '%s\t%s\t%s\n' \
    "$(date '+%FT%T%z' 2>/dev/null || echo '?')" \
    "$(basename "$0" 2>/dev/null || echo hook)" \
    "$msg" >> "$log" 2>/dev/null || true
}
