#!/bin/bash
# audit.sh — shared best-effort audit logger for Hektor hooks (Cursor port).
#
# Sourced by hooks to record security-relevant events (chiefly env-bypass use)
# to docs/hektor/.hook-audit.log.
#
# Identical to .claude/hooks/lib/audit.sh — the audit log path (docs/hektor/)
# is shared across both harnesses so bypass use is recorded in one place.
#
# Round2: the ORIGINAL silently no-op'd (`return 0`) whenever docs/hektor/ didn't exist yet, and
# swallowed a failed append the same way — a caller had NO way to tell "the bypass was logged" from
# "logging silently failed," which is exactly backwards for a SECURITY audit trail. Now: docs/hektor/
# is created on demand, and any failure (can't create the dir, can't append) prints a stderr
# WARNING instead of vanishing. Still never blocks the CALLING hook (a gate must never wedge the
# agent because its own logging failed) — hektor_audit's return code is informational, not fatal;
# callers do not (and should not) check it.
#
# Best-effort append-only hardening (honest framing: defense-in-depth, NOT a hard wall — an agent
# with a shell can always `chflags nouappend`/`chattr -a` first, and this whole log lives INSIDE
# the agent's own write scope, which is the real limitation here). Where supported, the log file is
# flagged append-only right after creation so a `>`-truncate, `rm`, or in-place rewrite fails at
# the OS layer even though `>>`-append keeps working — silently skipped wherever unsupported
# (non-Darwin/non-Linux, non-owner, an unsupporting filesystem). Ideally this log would live
# somewhere OUTSIDE the agent's write scope entirely (a separate service, syslog, a CI artifact
# store) — that's real hardening this file alone can't provide; out of scope here.
#
# Usage in a hook:
#   _LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
#   if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi
#   ...
#   hektor_audit "commit-gate bypassed (HEKTOR_COMMIT_GATE=off)"

hektor_audit() {
  local msg="$1" root dir log
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  dir="$root/docs/hektor"
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir" 2>/dev/null || {
      echo "hektor_audit: WARNING — could not create $dir; audit event NOT recorded: $msg" >&2
      return 1
    }
  fi
  log="$dir/.hook-audit.log"
  if [ ! -e "$log" ]; then
    { : >> "$log"; } 2>/dev/null
    case "$(uname -s 2>/dev/null)" in
      Darwin) chflags uappend "$log" 2>/dev/null || true ;;
      Linux)  chattr +a "$log" 2>/dev/null || true ;;
    esac
  fi
  if ! { printf '%s\t%s\t%s\n' \
    "$(date '+%FT%T%z' 2>/dev/null || echo '?')" \
    "$(basename "$0" 2>/dev/null || echo hook)" \
    "$msg" >> "$log"; } 2>/dev/null
  then
    echo "hektor_audit: WARNING — failed to append to $log; audit event NOT recorded: $msg" >&2
    return 1
  fi
}
