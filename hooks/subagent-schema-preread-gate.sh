#!/bin/bash
# subagent-schema-preread-gate.sh — forces a schema-validated dispatch to tell
#                                   the subagent which return schema to follow.
#
# Hook    : PreToolUse:Agent
# Mode    : DENY
# State   : none
# Env     : HEKTOR_SCHEMA_PREREAD_GATE=off   advisory bypass
#
# Why
# ---
# The return-schema-guard (PostToolUse) validates a subagent's return against
# its role schema — but only helps if the subagent knew the contract. This
# gate denies a schema-validated dispatch whose brief (tool_input.prompt) does
# not cite its schema filename, so the subagent is always told the shape it
# must return BEFORE it runs.
#
# Role-prefix -> schema basename (see .claude/schemas/subagent-returns/README.md):
#   composer-<j-slug>:                          composer.schema.json
#   probe-<j-slug>:                             probe.schema.json
#   workflow-reviewer-* / phase-validator-*     reviewer.schema.json
#   diagnosis-<...>:                            diagnosis.schema.json
#
# Dispatches without a recognised prefix are silent-allowed (gradual adoption).
#
# Port of Achilles' subagent-schema-preread-gate.sh, retargeted to Hektor roles.
set -uo pipefail

_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi

if [ "${HEKTOR_SCHEMA_PREREAD_GATE:-on}" = "off" ]; then
  hektor_audit "subagent-schema-preread-gate bypassed (HEKTOR_SCHEMA_PREREAD_GATE=off)"
  exit 0
fi

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
[ "$TOOL_NAME" = "Agent" ] || exit 0

DESCRIPTION=$(echo "$INPUT" | "$JQ" -r '.tool_input.description // ""' 2>/dev/null || echo "")

SCHEMA=""
case "$DESCRIPTION" in
  composer-*)         SCHEMA="composer.schema.json" ;;
  probe-*)            SCHEMA="probe.schema.json" ;;
  workflow-reviewer-*|phase-validator-*) SCHEMA="reviewer.schema.json" ;;
  diagnosis-*)        SCHEMA="diagnosis.schema.json" ;;
  *)                  exit 0 ;;
esac

PROMPT=$(echo "$INPUT" | "$JQ" -r '.tool_input.prompt // ""' 2>/dev/null || echo "")

if printf '%s' "$PROMPT" | grep -qF "$SCHEMA"; then
  exit 0
fi

"$JQ" -n --arg r "[BLOCKED — Hektor schema-preread-gate] Dispatch \"${DESCRIPTION}\" must cite its return schema.

This role's returns are validated against:
  .claude/schemas/subagent-returns/${SCHEMA}

The brief does not mention \`${SCHEMA}\`, so the subagent won't know the shape it
must return. Add a line to the brief naming the schema and its required fields,
e.g.:

  Return your result as YAML conforming to ${SCHEMA}: a handover block
  (role, status, next-action) plus the role's required fields.

Bypass (audit the use): HEKTOR_SCHEMA_PREREAD_GATE=off." '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": $r
  }
}'
exit 0
