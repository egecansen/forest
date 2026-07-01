#!/bin/bash
# reviewer-brief-gate.sh — brief-integrity gate for workflow-reviewer
#                          dispatches. Closes the orchestrator-to-reviewer
#                          brief-injection surface.
#
# Hook    : PreToolUse:Agent
# Mode    : DENY
# State   : none
# Env     : HEKTOR_REVIEWER_BRIEF_GATE=off   advisory bypass (audit the use)
#
# Why
# ---
# The reviewer is the orchestrator's only check against self-grading. But the
# BRIEF the orchestrator passes is unconstrained — it could omit the ledger
# path, send a one-line "just approve", or embed "user pre-authorised" framing.
# This gate requires a workflow-reviewer-* brief to contain all three:
#   1. Ledger reference  — the literal substring `run-status.json`.
#   2. Verification verb — at least one of Read / verify / inspect.
#   3. Minimum length    — >= 400 chars (a real brief is 4-5 sentences).
#
# It does NOT solve prompt injection — a sophisticated brief citing the paths
# AND embedding malicious instructions passes. It raises the bar from trivial
# bypass to "must survive methodology discipline + schema-validated return".
#
# Port of Achilles' workflow-reviewer-brief-gate.sh, retargeted to run-status.json.
set -uo pipefail

_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi

if [ "${HEKTOR_REVIEWER_BRIEF_GATE:-on}" = "off" ]; then
  hektor_audit "reviewer-brief-gate bypassed (HEKTOR_REVIEWER_BRIEF_GATE=off)"
  exit 0
fi

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0   # jq absent -> fail-open

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
[ "$TOOL_NAME" = "Agent" ] || exit 0

DESCRIPTION=$(echo "$INPUT" | "$JQ" -r '.tool_input.description // ""' 2>/dev/null || echo "")
case "$DESCRIPTION" in
  workflow-reviewer-*) ;;
  *) exit 0 ;;
esac

PROMPT=$(echo "$INPUT" | "$JQ" -r '.tool_input.prompt // ""' 2>/dev/null || echo "")

emit_deny() {
  "$JQ" -n --arg r "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $r
    }
  }'
}

VIOLATIONS=""
printf '%s' "$PROMPT" | grep -qF "run-status.json" || VIOLATIONS="${VIOLATIONS}
  - Missing ledger reference: the brief must cite docs/hektor/run-status.json (or the bare filename run-status.json) so the reviewer reads the ledger directly."
printf '%s' "$PROMPT" | grep -qiE '\b(read|verify|inspect)\b' || VIOLATIONS="${VIOLATIONS}
  - Missing verification verb: include one of Read / verify / inspect so the brief instructs on-disk verification, not trust in the orchestrator's summary."
PROMPT_LEN=${#PROMPT}
[ "$PROMPT_LEN" -lt 400 ] && VIOLATIONS="${VIOLATIONS}
  - Brief too short (${PROMPT_LEN} chars; minimum 400): a real reviewer brief states what phase/pass is reviewed, the exit criteria, the evidence sources (ledger + deliverable paths), and the return shape."

[ -z "$VIOLATIONS" ] && exit 0

emit_deny "[BLOCKED — Hektor reviewer-brief-gate] workflow-reviewer dispatch brief fails integrity check.

Description: \"${DESCRIPTION}\"

Violations:${VIOLATIONS}

The reviewer is the only check against self-grading. A brief that withholds the
canonical inputs defeats the protocol. Rewrite it to read roughly:

  You are workflow-reviewer-<phase|pass>-<N>.
  Read docs/hektor/run-status.json and verify phases.<N> deliverables against
  the exit criteria in <skill ref>. Verify the cited files on disk before any
  verdict. Return verdict: approve only after on-disk verification, citing the
  files you read.

Bypass (audit the use): HEKTOR_REVIEWER_BRIEF_GATE=off in the environment."
exit 0
