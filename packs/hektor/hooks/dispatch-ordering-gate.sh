#!/bin/bash
# dispatch-ordering-gate.sh — phase-sequence state-machine gate. Forces a
#                             reviewer dispatch at a phase transition and blocks
#                             out-of-order phase advancement.
#
# Hook    : PreToolUse:Agent
# Mode    : DENY
# State   : reads docs/hektor/run-status.json
# Env     : HEKTOR_ORDERING_GATE=off   advisory bypass
#
# Why
# ---
# run-status-write-gate gates WHO may land an approval and WHAT shape the ledger
# has — but not the SEQUENCE. This gate is the other half: it stops the
# orchestrator from starting phase N+1's work while phase N is finished but not
# yet reviewer-approved, and forces the matching workflow-reviewer-* dispatch
# first. Port of Achilles' onboarding-ledger-gate.sh (phase-level rules only;
# Achilles' Phase-4-cycle / Phase-5-pass substage rules read a subStages ledger
# Hektor doesn't carry).
#
# OPT-IN by design (non-breaking)
# -------------------------------
# Only phases that explicitly carry a `reviewerVerdict` field are gated. A run
# that doesn't use the reviewer pattern never sets the field and is never
# blocked — same gradual-adoption model as the reviewer cluster. A run opts in
# by setting `reviewerVerdict: "pending"` on a phase when it completes.
#
# Rules
# -----
# 1. Allow-list: workflow-reviewer-* / phase-validator-* dispatches ALWAYS pass.
# 2. Transition point: if some phase has status completed|blocked AND carries
#    reviewerVerdict != "approved", a non-reviewer dispatch is DENIED until that
#    phase's reviewer has approved.
# 3. Out-of-order: if the dispatch declares a target phase (description prefix
#    `phase-<N>-` / `phase<N>-`) ahead of currentPhase and the prior phase
#    carries reviewerVerdict != "approved", DENY.
# 4. Missing / malformed ledger, or no opted-in phases → silent allow.
set -uo pipefail

_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi

if [ "${HEKTOR_ORDERING_GATE:-on}" = "off" ]; then
  hektor_audit "dispatch-ordering-gate bypassed (HEKTOR_ORDERING_GATE=off)"
  exit 0
fi

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
[ "$TOOL_NAME" = "Agent" ] || exit 0

DESCRIPTION=$(echo "$INPUT" | "$JQ" -r '.tool_input.description // ""' 2>/dev/null || echo "")
[ -n "$DESCRIPTION" ] || exit 0

# Rule 1: reviewers / validators always pass.
case "$DESCRIPTION" in
  workflow-reviewer-*|phase-validator-*) exit 0 ;;
esac

GUARD_CWD=$(echo "$INPUT" | "$JQ" -r '.cwd // "."' 2>/dev/null || echo ".")
REPO_ROOT=$(git -C "$GUARD_CWD" rev-parse --show-toplevel 2>/dev/null || echo "$GUARD_CWD")
LEDGER="$REPO_ROOT/docs/hektor/run-status.json"
[ -f "$LEDGER" ] || exit 0
"$JQ" -e '.' "$LEDGER" >/dev/null 2>&1 || exit 0   # malformed -> silent allow

emit_deny() {
  "$JQ" -n --arg r "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $r
    }
  }'
}

# Rule 2: transition point — highest-numbered phase that is done (completed|
# blocked) AND opted into review (has reviewerVerdict) AND not yet approved.
PENDING_PHASE=$("$JQ" -r '
  (.phases // {}) | to_entries
  | map(select(
      (.value.status == "completed" or .value.status == "blocked")
      and (.value | has("reviewerVerdict"))
      and (.value.reviewerVerdict != "approved")))
  | map(.key | select(test("^[0-9]+$")) | tonumber)
  | if length == 0 then "" else (max | tostring) end
' "$LEDGER" 2>/dev/null || echo "")

if [ -n "$PENDING_PHASE" ]; then
  VERDICT=$("$JQ" -r --arg k "$PENDING_PHASE" '.phases[$k].reviewerVerdict // "pending"' "$LEDGER" 2>/dev/null || echo "pending")
  emit_deny "[BLOCKED — Hektor dispatch-ordering-gate] Phase ${PENDING_PHASE} is finished but not reviewer-approved (reviewerVerdict: \"${VERDICT}\").

Description: \"${DESCRIPTION}\"

Every phase transition is gated by a reviewer. The orchestrator cannot start the
next unit of work until phase ${PENDING_PHASE}'s reviewer has returned
verdict: approve and that approval is landed in docs/hektor/run-status.json.

Fix: dispatch \`workflow-reviewer-phase-${PENDING_PHASE}\` next. Brief it to Read
the ledger row + the closing subagent's deliverables and verify them against the
phase's exit criteria before any verdict. (That brief is itself checked by
reviewer-brief-gate; the approval write by run-status-write-gate.)

Bypass (audit the use): HEKTOR_ORDERING_GATE=off."
  exit 0
fi

# Rule 3: out-of-order — explicit target-phase hint ahead of an unapproved prior.
CURRENT_PHASE=$("$JQ" -r '.currentPhase // empty' "$LEDGER" 2>/dev/null || echo "")
case "$CURRENT_PHASE" in ''|*[!0-9]*) exit 0 ;; esac

TARGET_PHASE=$(printf '%s' "$DESCRIPTION" | sed -nE 's/^[[:space:]]*phase-?([0-9]+)[-_:].*/\1/p' | head -1)
case "$TARGET_PHASE" in ''|*[!0-9]*) exit 0 ;; esac

if [ "$TARGET_PHASE" -gt "$CURRENT_PHASE" ]; then
  PRIOR=$((TARGET_PHASE - 1))
  # Only enforce if the prior phase opted into review.
  PRIOR_HAS=$("$JQ" -r --arg k "$PRIOR" '(.phases[$k] // {}) | has("reviewerVerdict")' "$LEDGER" 2>/dev/null || echo "false")
  if [ "$PRIOR_HAS" = "true" ]; then
    PRIOR_VERDICT=$("$JQ" -r --arg k "$PRIOR" '.phases[$k].reviewerVerdict // "pending"' "$LEDGER" 2>/dev/null || echo "pending")
    if [ "$PRIOR_VERDICT" != "approved" ]; then
      emit_deny "[BLOCKED — Hektor dispatch-ordering-gate] Out-of-order dispatch — phase ${TARGET_PHASE} cannot start while phase ${PRIOR} is not reviewer-approved.

Description: \"${DESCRIPTION}\"

Ledger: currentPhase = ${CURRENT_PHASE}; phase ${PRIOR} reviewerVerdict = \"${PRIOR_VERDICT}\" (must be \"approved\").

Fix: dispatch \`workflow-reviewer-phase-${PRIOR}\` first. On approve, the ledger
advances (reviewerVerdict → approved, currentPhase → ${TARGET_PHASE}) and this
dispatch can be re-issued.

Bypass (audit the use): HEKTOR_ORDERING_GATE=off."
      exit 0
    fi
  fi
fi

exit 0
