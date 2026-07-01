#!/bin/bash
# audit.sh — shared best-effort audit logger for Hektor hooks.
#
# Sourced by hooks to record security-relevant events (chiefly env-bypass use)
# to docs/hektor/.hook-audit.log. Never fails the caller: any error in resolving
# the repo root, the dir, the timestamp, or the append is swallowed.
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
  local msg="$1" root log
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  [ -d "$root/docs/hektor" ] || return 0
  log="$root/docs/hektor/.hook-audit.log"
  msg="$(printf '%s' "$msg" | hektor_redact)"
  printf '%s\t%s\t%s\n' \
    "$(date '+%FT%T%z' 2>/dev/null || echo '?')" \
    "$(basename "$0" 2>/dev/null || echo hook)" \
    "$msg" >> "$log" 2>/dev/null || true
}
