#!/bin/bash
# run-status-write-gate.sh — integrity + actor-identity gate for writes to
#                            docs/hektor/run-status.json.
#
# Hook    : PreToolUse:Write|Edit
# Mode    : DENY
# State   : reads the current ledger (on disk) + docs/hektor/.workflow-approvers.json
# Env     : HEKTOR_RUN_STATUS_GATE=off   advisory bypass (audit the use)
#
# What it gates (jq-driven; no node/ajv dependency)
# -------------------------------------------------
# 1. Proposed run-status.json is not parseable JSON                  -> DENY
# 2. A phase NEWLY set to status:"skipped" without a matching
#    approvedDeviations[] entry carrying a non-empty `authorizer`
#    (verbatim user quote) OR a structural reason prefix
#    (blocked-on-app-bug: / test-data-prerequisite: / user-authorised:) -> DENY
# 3. A phase NEWLY set to reviewerVerdict:"approved" while the write
#    comes from orchestrator context (no parent_tool_use_id) OR from a
#    subagent not in the approver registry / whose entry expired      -> DENY
#
# Hektor's ledger keys `phases` by phase id ("1","2",...), so all phase
# scans use `.phases | to_entries`. The reviewerVerdict field extends the
# slim schema in METHODOLOGY.md per the workflow-reviewer pattern the
# orchestrator SKILL references. Self-imposed reasons (budget, session-length,
# auto-mode) are NOT authorisation — mirrors METHODOLOGY.md's ledger contract.
#
# Input-tolerant: missing ledger on disk (first write) / unextractable
# content / jq failure -> silent allow, never wedge the pipeline.
set -uo pipefail

_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi

if [ "${HEKTOR_RUN_STATUS_GATE:-on}" = "off" ]; then
  hektor_audit "run-status-write-gate bypassed (HEKTOR_RUN_STATUS_GATE=off)"
  exit 0
fi

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
case "$TOOL_NAME" in Write|Edit) ;; *) exit 0 ;; esac

TARGET=$(echo "$INPUT" | "$JQ" -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
case "$TARGET" in
  */docs/hektor/run-status.json) ;;
  *) exit 0 ;;
esac

emit_deny() {
  "$JQ" -n --arg r "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $r
    }
  }'
}

# Reconstruct the proposed content.
PROPOSED=""
case "$TOOL_NAME" in
  Write)
    PROPOSED=$(echo "$INPUT" | "$JQ" -r '.tool_input.content // empty' 2>/dev/null || echo "")
    ;;
  Edit)
    OLD=$(echo "$INPUT" | "$JQ" -r '.tool_input.old_string // empty' 2>/dev/null || echo "")
    if [ -f "$TARGET" ] && [ -n "$OLD" ]; then
      NEW=$(echo "$INPUT" | "$JQ" -r '.tool_input.new_string // empty' 2>/dev/null || echo "")
      # Literal (NOT regex) replacement of every occurrence of OLD with NEW.
      # awk sub() treats its first arg as ERE and NEW's `&` as special — a
      # metachar in old_string would mis-reconstruct and could fail OPEN (drop
      # the approval transition so the gate never sees it). index()-based
      # splitting is literal and safe.
      PROPOSED=$(awk -v o="$OLD" -v n="$NEW" '
        BEGIN { RS="\0" }
        {
          rest=$0; out="";
          if (o == "") { printf "%s", rest; next }
          while ((p=index(rest,o)) > 0) {
            out = out substr(rest,1,p-1) n;
            rest = substr(rest, p+length(o));
          }
          printf "%s", out rest;
        }
      ' "$TARGET" 2>/dev/null || echo "")
    fi
    ;;
esac
[ -n "$PROPOSED" ] || exit 0

# Check 1: parseable JSON.
if ! printf '%s' "$PROPOSED" | "$JQ" -e '.' >/dev/null 2>&1; then
  emit_deny "[BLOCKED — Hektor run-status-gate] Proposed run-status.json is not parseable JSON. Fix the syntax before writing the ledger."
  exit 0
fi

PROP_TMP=$(mktemp /tmp/hektor-runstatus-XXXXXX.json)
trap 'rm -f "$PROP_TMP"' EXIT
printf '%s' "$PROPOSED" > "$PROP_TMP"

# Prior on-disk ledger (empty object if first write).
PRIOR='{}'
[ -f "$TARGET" ] && PRIOR=$(cat "$TARGET" 2>/dev/null || echo '{}')
echo "$PRIOR" | "$JQ" -e '.' >/dev/null 2>&1 || PRIOR='{}'

# --- Check 2: skipped phases need authorisation. -----------------------------
# Phase ids newly at status:"skipped" (skipped in proposed, not skipped before).
NEW_SKIPPED=$("$JQ" -n --slurpfile prop "$PROP_TMP" --argjson prior "$PRIOR" '
  ($prop[0].phases // {}) as $np
  | ($prior.phases // {}) as $op
  | [ $np | to_entries[]
      | select(.value.status == "skipped")
      | select((($op[.key].status) // "") != "skipped")
      | .key ]
' 2>/dev/null || echo "[]")

if [ "$(echo "$NEW_SKIPPED" | "$JQ" 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
  # For each newly-skipped phase, require an approvedDeviations[] entry whose
  # phase matches AND (authorizer non-empty OR reason has a structural prefix).
  UNAUTHORISED=$("$JQ" -n --slurpfile prop "$PROP_TMP" --argjson skipped "$NEW_SKIPPED" '
    ($prop[0].approvedDeviations // []) as $dev
    | [ $skipped[]
        | . as $pid
        | select(
            ($dev | any(
              ((.phase|tostring) == $pid)
              and (
                (((.authorizer // "") | length) > 0)
                or ((.reason // "") | test("^(blocked-on-app-bug:|test-data-prerequisite:|user-authorised:)"))
              )
            )) | not
          ) ]
  ' 2>/dev/null || echo "[]")

  if [ "$(echo "$UNAUTHORISED" | "$JQ" 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
    BAD=$(echo "$UNAUTHORISED" | "$JQ" -r 'join(", ")' 2>/dev/null || echo "?")
    emit_deny "[BLOCKED — Hektor run-status-gate] Phase(s) ${BAD} set to status: \"skipped\" without authorisation.

A phase skip requires a matching approvedDeviations[] entry carrying EITHER:
  - an \"authorizer\" field with the user's verbatim quote authorising the skip, OR
  - a \"reason\" beginning with a structural prefix: blocked-on-app-bug:<id>,
    test-data-prerequisite:<thing>, or user-authorised:<verbatim>.

Self-imposed reasons (budget, session-length, auto-mode) are NOT authorisation —
that mirrors METHODOLOGY.md's status-ledger contract. Ask the user for an
authorising quote and record it; do not infer authorisation from prior context.

Bypass (audit the use): HEKTOR_RUN_STATUS_GATE=off."
    exit 0
  fi
fi

# --- Check 3: approvals need a registered approver actor. --------------------
NEW_APPROVED=$("$JQ" -n --slurpfile prop "$PROP_TMP" --argjson prior "$PRIOR" '
  ($prop[0].phases // {}) as $np
  | ($prior.phases // {}) as $op
  | [ $np | to_entries[]
      | select(.value.reviewerVerdict == "approved")
      | select((($op[.key].reviewerVerdict) // "") != "approved")
      | .key ]
' 2>/dev/null || echo "[]")

if [ "$(echo "$NEW_APPROVED" | "$JQ" 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
  SUMMARY=$(echo "$NEW_APPROVED" | "$JQ" -r 'join(", ")' 2>/dev/null || echo "?")
  PARENT_ID=$(echo "$INPUT" | "$JQ" -r '.parent_tool_use_id // empty' 2>/dev/null || echo "")

  if [ -z "$PARENT_ID" ]; then
    emit_deny "[BLOCKED — Hektor run-status-gate] Ledger sets phase(s) ${SUMMARY} to reviewerVerdict: \"approved\" but the write comes from orchestrator context (no parent_tool_use_id).

Only a registered reviewer/validator subagent may land an approval — the
orchestrator cannot grade its own work. Dispatch a workflow-reviewer-* (or
phase-validator-*) subagent; let THAT subagent write the approval after on-disk
verification.

Bypass (audit the use): HEKTOR_RUN_STATUS_GATE=off."
    exit 0
  fi

  REGISTRY="$(dirname "$TARGET")/.workflow-approvers.json"
  if [ ! -f "$REGISTRY" ]; then
    emit_deny "[BLOCKED — Hektor run-status-gate] Phase(s) ${SUMMARY} approved from a subagent, but no approver registry exists at ${REGISTRY}.

The registry is written by reviewer-approver-registry.sh when a workflow-reviewer-*
/ phase-validator-* subagent is dispatched. Its absence means no approver was
ever registered — the approval can't be attributed. Dispatch a reviewer subagent
first.

Bypass (audit the use): HEKTOR_RUN_STATUS_GATE=off."
    exit 0
  fi

  ENTRY=$("$JQ" -c --arg id "$PARENT_ID" '.[$id] // empty' "$REGISTRY" 2>/dev/null || echo "")
  if [ -z "$ENTRY" ]; then
    emit_deny "[BLOCKED — Hektor run-status-gate] Phase(s) ${SUMMARY} approved, but the dispatching subagent (parent_tool_use_id=${PARENT_ID}) is NOT in the approver registry.

Only subagents dispatched with a workflow-reviewer-* / phase-validator-* role
prefix are registered as approvers. This write's parent is not one of them.

Bypass (audit the use): HEKTOR_RUN_STATUS_GATE=off."
    exit 0
  fi

  NOW=$(date +%s 2>/dev/null || echo 0)
  TS=$("$JQ" -r '.ts // 0' <<< "$ENTRY" 2>/dev/null || echo 0)
  TTL=1800
  if [ "$NOW" -gt 0 ] && [ "$TS" -gt 0 ] && [ $((NOW - TS)) -gt "$TTL" ]; then
    emit_deny "[BLOCKED — Hektor run-status-gate] Phase(s) ${SUMMARY} approved from an approver whose registry entry expired (age $((NOW - TS))s, TTL ${TTL}s).

Re-dispatch the reviewer subagent so a fresh approver entry is recorded, then
write the approval.

Bypass (audit the use): HEKTOR_RUN_STATUS_GATE=off."
    exit 0
  fi
fi

exit 0
