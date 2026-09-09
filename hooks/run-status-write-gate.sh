#!/bin/bash
# run-status-write-gate.sh — integrity + actor-identity gate for writes to
#                            docs/hektor/run-status.json.
#
# Event   : preToolUse  (any write-shaped tool call)
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

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

[ "${HEKTOR_RUN_STATUS_GATE:-on}" = "off" ] && { hektor_audit "run-status-write-gate bypassed (HEKTOR_RUN_STATUS_GATE=off)"; exit 0; }
hektor_gate_init run-status-write-gate "standard,strict"

TARGET="$(hektor_file_path)"
case "$TARGET" in
  */docs/hektor/run-status.json) ;;
  *) exit 0 ;;
esac

emit_deny() { hektor_deny "$1"; }

# Reconstruct the proposed content. A whole-file write is already it; a partial
# edit is replayed against disk with a LITERAL (not regex) index() replace —
# awk sub() treats its first arg as ERE and NEW's `&` as special, so a metachar
# in old_string would mis-reconstruct and could fail OPEN (drop the approval
# transition so the gate never sees it).
PROPOSED=""
OLD="$(hektor_old_string)"
if [ -z "$OLD" ]; then
  PROPOSED="$(hektor_added_text)"
elif [ -f "$TARGET" ]; then
  NEW="$(hektor_new_string)"
  PROPOSED=$(_o="$OLD" _n="$NEW" awk '
    BEGIN { RS="\0"; o=ENVIRON["_o"]; n=ENVIRON["_n"] }
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
[ -n "$PROPOSED" ] || exit 0

# Check 1: parseable JSON.
if ! printf '%s' "$PROPOSED" | "$CC_JQ" -e '.' >/dev/null 2>&1; then
  emit_deny "[BLOCKED — Hektor run-status-gate] Proposed run-status.json is not parseable JSON. Fix the syntax before writing the ledger."
  exit 0
fi

PROP_TMP=$(mktemp /tmp/hektor-runstatus-XXXXXX.json)
trap 'rm -f "$PROP_TMP"' EXIT
printf '%s' "$PROPOSED" > "$PROP_TMP"

# Prior on-disk ledger (empty object if first write).
PRIOR='{}'
[ -f "$TARGET" ] && PRIOR=$(cat "$TARGET" 2>/dev/null || echo '{}')
echo "$PRIOR" | "$CC_JQ" -e '.' >/dev/null 2>&1 || PRIOR='{}'

# --- Check 2: skipped phases need authorisation. -----------------------------
# Phase ids newly at status:"skipped" (skipped in proposed, not skipped before).
NEW_SKIPPED=$("$CC_JQ" -n --slurpfile prop "$PROP_TMP" --argjson prior "$PRIOR" '
  ($prop[0].phases // {}) as $np
  | ($prior.phases // {}) as $op
  | [ $np | to_entries[]
      | select(.value.status == "skipped")
      | select((($op[.key].status) // "") != "skipped")
      | .key ]
' 2>/dev/null || echo "[]")

if [ "$(printf '%s' "$NEW_SKIPPED" | "$CC_JQ" 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
  # For each newly-skipped phase, require an approvedDeviations[] entry whose
  # phase matches AND (authorizer non-empty OR reason has a structural prefix).
  UNAUTHORISED=$("$CC_JQ" -n --slurpfile prop "$PROP_TMP" --argjson skipped "$NEW_SKIPPED" '
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

  if [ "$(echo "$UNAUTHORISED" | "$CC_JQ" 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
    BAD=$(echo "$UNAUTHORISED" | "$CC_JQ" -r 'join(", ")' 2>/dev/null || echo "?")
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

# --- Check 3: approvals need an open approver lease. -------------------------
#
# On Claude Code this matched the write's `parent_tool_use_id` against the
# approver registry, proving the approval was written from inside the reviewer
# subagent. Cursor exposes no parent-call link on a tool call, so the check
# degrades to a LEASE: an approval may land only while a workflow-reviewer-* /
# phase-validator-* subagent has started within the registry's TTL. That keeps
# the property that matters — the orchestrator cannot approve without a reviewer
# having actually run — and drops the one Cursor cannot support, proving the
# write originated inside it. See docs/cursor-parity.md.
NEW_APPROVED=$("$CC_JQ" -n --slurpfile prop "$PROP_TMP" --argjson prior "$PRIOR" '
  ($prop[0].phases // {}) as $np
  | ($prior.phases // {}) as $op
  | [ $np | to_entries[]
      | select(.value.reviewerVerdict == "approved")
      | select((($op[.key].reviewerVerdict) // "") != "approved")
      | .key ]
' 2>/dev/null || echo "[]")

if [ "$(printf '%s' "$NEW_APPROVED" | "$CC_JQ" 'length' 2>/dev/null || echo 0)" -gt 0 ]; then
  SUMMARY=$(printf '%s' "$NEW_APPROVED" | "$CC_JQ" -r 'join(", ")' 2>/dev/null || echo "?")
  REGISTRY="$(dirname "$TARGET")/.workflow-approvers.json"

  if [ ! -f "$REGISTRY" ]; then
    emit_deny "[BLOCKED — Hektor run-status-gate] Phase(s) ${SUMMARY} set to reviewerVerdict: \"approved\", but no approver has ever been registered (${REGISTRY} does not exist).

Only a reviewer/validator subagent may land an approval — the orchestrator
cannot grade its own work. Dispatch a workflow-reviewer-* (or phase-validator-*)
subagent, let it verify on disk, and write the approval while its lease is open.

Bypass (audit the use): HEKTOR_RUN_STATUS_GATE=off."
    exit 0
  fi

  NOW=$(date +%s 2>/dev/null || echo 0)
  TTL=1800
  # Is any approver lease still inside its TTL?
  FRESH=$("$CC_JQ" -r --argjson now "$NOW" --argjson ttl "$TTL" '
    [ to_entries[] | select((.value.ts // 0) >= ($now - $ttl)) ] | length
  ' "$REGISTRY" 2>/dev/null || echo 0)

  if [ "${FRESH:-0}" -lt 1 ]; then
    NEWEST=$("$CC_JQ" -r '[ to_entries[] | .value.ts // 0 ] | max // 0' "$REGISTRY" 2>/dev/null || echo 0)
    AGE="unknown"
    [ "${NOW:-0}" -gt 0 ] && [ "${NEWEST:-0}" -gt 0 ] && AGE="$((NOW - NEWEST))s"
    emit_deny "[BLOCKED — Hektor run-status-gate] Phase(s) ${SUMMARY} approved, but no approver lease is open (newest entry age: ${AGE}, TTL ${TTL}s).

An approval must be written while a workflow-reviewer-* / phase-validator-*
subagent is running or has just finished. A stale registry means the reviewer
ran long ago — or never for this phase — so the approval cannot be attributed.

Fix: re-dispatch the reviewer subagent so a fresh lease is recorded, let it
verify the deliverables on disk, then write the approval.

Bypass (audit the use): HEKTOR_RUN_STATUS_GATE=off."
    exit 0
  fi
fi

exit 0
