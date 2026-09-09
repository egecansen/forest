#!/bin/bash
# enforcement-self-protection-gate.sh — stops the gated party from silently
#                                       disabling the enforcement layer.
#
# Hook    : PreToolUse:Write|Edit
# Mode    : DENY
# State   : none
# Env     : HEKTOR_HOOKS_UNLOCK=1   required to edit the enforcement layer
#
# Why
# ---
# Every other hook polices the orchestrator, but settings.json and the hook
# scripts themselves were writable by that same orchestrator with nothing
# guarding them — so the whole layer could be unregistered or neutered with a
# single Edit. This gate denies Write/Edit to the enforcement surface:
#   - .claude/settings.json          (hook registration)
#   - .claude/hooks/**/*.sh + lib/   (the hooks + this gate; .md docs excluded)
#   - .claude/schemas/subagent-returns/*.schema.json  (the contracts; .md excluded)
#
# This is FRICTION, not a wall: a determined agent can set HEKTOR_HOOKS_UNLOCK=1
# (or, before this gate is live, edit freely). The point is to convert casual /
# accidental self-modification into a deliberate, audited act. Legitimate hook
# maintenance sets the unlock flag; the use is logged to docs/hektor/.hook-audit.log.
#
# Failure -> action
# -----------------
# - Write/Edit to the enforcement surface, unlock NOT set  -> DENY
# - Same, with HEKTOR_HOOKS_UNLOCK=1                        -> ALLOW (audited)
# - Anything else                                          -> silent allow
set -uo pipefail

_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
case "$TOOL_NAME" in Write|Edit) ;; *) exit 0 ;; esac

TARGET=$(echo "$INPUT" | "$JQ" -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[ -n "$TARGET" ] || exit 0

# Is the target on the enforcement surface?
case "$TARGET" in
  */.claude/settings.json|*/.claude/settings.local.json) SURFACE="settings.json" ;;
  */.claude/hooks/*.sh|*/.claude/hooks/lib/*) SURFACE="hook script" ;;
  */.claude/schemas/subagent-returns/*.schema.json) SURFACE="return schema" ;;
  *) exit 0 ;;
esac

# Unlock honoured (and audited).
if [ "${HEKTOR_HOOKS_UNLOCK:-0}" = "1" ]; then
  hektor_audit "enforcement layer unlocked for write: ${TARGET} (HEKTOR_HOOKS_UNLOCK=1)"
  exit 0
fi

"$JQ" -n --arg r "[BLOCKED — Hektor self-protection-gate] Refusing to modify the enforcement layer (${SURFACE}).

Target: ${TARGET}

The hooks, their registration in settings.json, and the return schemas police
this agent's own behaviour — editing them from agent context is how the whole
layer would be silently disabled. This write is denied by default.

If this is legitimate hook maintenance, set HEKTOR_HOOKS_UNLOCK=1 in the
environment for the command. The unlock is recorded in
docs/hektor/.hook-audit.log so the change is deliberate and auditable.

This gate is friction, not a security boundary — see .claude/hooks/README.md
§Vulnerabilities." '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": $r
  }
}'
exit 0
