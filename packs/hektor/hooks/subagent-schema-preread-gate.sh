#!/bin/bash
# subagent-schema-preread-gate.sh — forces a schema-validated dispatch to tell
#                                   the subagent which return schema to follow.
#
# Event   : subagentStart
# Mode    : DENY
# State   : none
# Env     : HEKTOR_SCHEMA_PREREAD_GATE=off   advisory bypass
#
# Why
# ---
# The return-schema-guard (subagentStop) validates a subagent's return against
# its role schema — but only helps if the subagent knew the contract. This
# gate denies a schema-validated dispatch whose brief (tool_input.prompt) does
# not cite its schema filename, so the subagent is always told the shape it
# must return BEFORE it runs.
#
# Role-prefix -> schema basename (see .cursor/schemas/subagent-returns/README.md):
#   composer-<j-slug>:                          composer.schema.json
#   probe-<j-slug>:                             probe.schema.json
#   workflow-reviewer-* / phase-validator-*     reviewer.schema.json
#   diagnosis-<...>:                            diagnosis.schema.json
#
# Dispatches without a recognised prefix are silent-allowed (gradual adoption).
#
# Port of Achilles' subagent-schema-preread-gate.sh, retargeted to Hektor roles.
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

[ "${HEKTOR_SCHEMA_PREREAD_GATE:-on}" = "off" ] && { hektor_audit "subagent-schema-preread-gate bypassed (HEKTOR_SCHEMA_PREREAD_GATE=off)"; exit 0; }
hektor_gate_init subagent-schema-preread-gate "standard,strict"

DESCRIPTION="$(hektor_role)"

SCHEMA=""
case "$DESCRIPTION" in
  composer-*)         SCHEMA="composer.schema.json" ;;
  probe-*)            SCHEMA="probe.schema.json" ;;
  workflow-reviewer-*|phase-validator-*) SCHEMA="reviewer.schema.json" ;;
  diagnosis-*)        SCHEMA="diagnosis.schema.json" ;;
  *)                  exit 0 ;;
esac

PROMPT="$(hektor_brief)"

if printf '%s' "$PROMPT" | grep -qF "$SCHEMA"; then
  exit 0
fi

hektor_deny "[BLOCKED — Hektor schema-preread-gate] Dispatch \"${DESCRIPTION}\" must cite its return schema.

This role's returns are validated against:
  .cursor/schemas/subagent-returns/${SCHEMA}

The brief does not mention \`${SCHEMA}\`, so the subagent won't know the shape it
must return. Add a line to the brief naming the schema and its required fields,
e.g.:

  Return your result as YAML conforming to ${SCHEMA}: a handover block
  (role, status, next-action) plus the role's required fields.

Bypass (audit the use): HEKTOR_SCHEMA_PREREAD_GATE=off."
exit 0
