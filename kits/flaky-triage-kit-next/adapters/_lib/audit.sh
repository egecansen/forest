#!/bin/bash
# audit.sh — shared best-effort audit logger for Hektor hooks.
#
# Sourced by hooks to record security-relevant events (chiefly env-bypass use)
# to docs/hektor/.hook-audit.log.
#
# TWO COPIES, ONE CONTENT. This file lives in two places and MUST stay byte-identical:
#   hooks/lib/audit.sh                        (the pack — installed to .claude/hooks/lib/)
#   kits/flaky-triage-kit/adapters/_lib/audit.sh   (the kit — vendored to .claude/ AND .cursor/hooks/lib/)
# Both harnesses append to the SAME docs/hektor/.hook-audit.log so bypass use is recorded in one
# place. Drift check is a plain `diff` of the two paths — keep it exact, not merely equivalent.
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
# Round4 (drift repair — why the "two copies, one content" rule above is stated so bluntly): the two
# copies had silently forked in BOTH directions and each was missing the other's fix.
#   - The kit copy forked BEFORE `hektor_redact` landed, and never picked it up — so the kit logged
#     its messages RAW. A credential sink, not a cosmetic gap: the self-protection gate's Bash
#     branch sets `TARGET="$CMDSTR"` (the WHOLE command string) and feeds it to `hektor_audit`, so
#     any token/password/URL-credential in an unlocked write command landed in the log verbatim.
#   - The pack copy never received Round2, so it still silently no-op'd whenever docs/hektor/ was
#     absent — the exact "was it logged, or did logging fail?" ambiguity Round2 existed to kill.
# Both fixes now live here. Redaction is applied ONCE at the top of `hektor_audit`, which also
# covers the two stderr WARNING paths — those echo the message too, and would otherwise leak the
# same secret to the terminal on a logging failure.
#
# Usage in a hook:
#   _LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
#   if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi
#   ...
#   hektor_audit "commit-gate bypassed (HEKTOR_COMMIT_GATE=off)"

# hektor_redact — strip secrets/tokens from a string before it is persisted.
# Linear-time, bounded sed patterns (ported from ECC session-activity-tracker.js
# redactSecrets + governance-capture SECRET_PATTERNS). Reused by observe.sh so
# neither the audit log nor the observation jsonl becomes a credential sink.
# Reads stdin, writes the redacted text to stdout.
#
# FAILS CLOSED: if sed errors (e.g. an old BSD/busybox sed that rejects the `I`
# flag) we emit a placeholder, NEVER the raw input — a redactor that leaks on
# failure is worse than useless.
hektor_redact() {
  local in out rc
  in="$(cat)"
  out="$(printf '%s' "$in" | sed -E \
    -e 's/(--?(token|password|passwd|secret|api[_-]?key|auth)[=[:space:]])[^[:space:]"'"'"']+/\1[REDACTED]/gI' \
    -e 's/((api[_-]?key|secret|password|passwd|token|authorization|credentials?)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?)[A-Za-z0-9_./+=-]{8,}/\1[REDACTED]/gI' \
    -e 's#([A-Za-z][A-Za-z0-9+.-]*://)[^/@[:space:]]+:[^/@[:space:]]+@#\1[REDACTED]@#g' \
    -e 's/(Authorization:[[:space:]]*(Bearer|Basic|Token)[[:space:]]+)[A-Za-z0-9._~+/=-]+/\1[REDACTED]/gI' \
    -e 's/(A(KIA|SIA)|ghp_|gho_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{10,}/[REDACTED]/g' \
    -e 's/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/[REDACTED-JWT]/g' \
    2>/dev/null)"; rc=$?
  if [ "$rc" -ne 0 ] || { [ -n "$in" ] && [ -z "$out" ]; }; then
    printf '[REDACTION-UNAVAILABLE]'
  else
    printf '%s' "$out"
  fi
}

# hektor_additional_context — emit a PreToolUse steering payload that the MODEL
# reads (not just stderr), so a guidance gate can say "you're missing field X"
# and the agent self-corrects on the next turn. ECC pretooluse-visible-output.js
# pattern. Needs jq; prints the hookSpecificOutput envelope to stdout.
hektor_additional_context() {
  local jq; jq="$(command -v jq || true)"; [ -n "$jq" ] || return 0
  "$jq" -n --arg c "$1" '{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "additionalContext": $c } }'
}

hektor_audit() {
  local msg="$1" root dir log
  # Redact FIRST: everything downstream (the log append AND both stderr warnings) uses $msg.
  msg="$(printf '%s' "$msg" | hektor_redact)"
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
