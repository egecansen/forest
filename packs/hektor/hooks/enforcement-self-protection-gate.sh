#!/bin/bash
# enforcement-self-protection-gate.sh — stops the gated party from silently
#                                       disabling the enforcement layer.
#
# Event   : preToolUse  (any write-shaped tool call)
# Mode    : DENY
# State   : none
# Env     : HEKTOR_HOOKS_UNLOCK=1   required to edit the enforcement layer
#
# Why
# ---
# Every other hook polices the orchestrator, but the hook registration and the
# hook scripts themselves were writable by that same orchestrator with nothing
# guarding them — so the whole layer could be unregistered or neutered with a
# single edit. This gate denies writes to the enforcement surface:
#   - .cursor/hooks.json             (hook registration)
#   - .cursor/hooks/**/*.sh + lib/   (the hooks + this gate; .md docs excluded)
#   - .cursor/schemas/subagent-returns/*.schema.json  (the contracts; .md excluded)
#
# Skills, agents and rules are deliberately NOT on this surface — they are meant
# to be edited and contributed to. Only the machinery that polices the agent is
# locked.
#
# This is FRICTION, not a wall: a determined agent can set HEKTOR_HOOKS_UNLOCK=1
# (or, before this gate is live, edit freely). The point is to convert casual /
# accidental self-modification into a deliberate, audited act. Legitimate hook
# maintenance sets the unlock flag; the use is logged to docs/hektor/.hook-audit.log.
#
# Failure -> action
# -----------------
# - A write to the enforcement surface, unlock NOT set     -> DENY
# - Same, with HEKTOR_HOOKS_UNLOCK=1                        -> ALLOW (audited)
# - Anything else                                          -> silent allow
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

hektor_gate_init enforcement-self-protection-gate "standard,strict"

TARGET="$(hektor_file_path)"
[ -n "$TARGET" ] || exit 0

# Is the target on the enforcement surface?
case "$TARGET" in
  */.cursor/hooks.json)                              SURFACE="hooks.json" ;;
  */.cursor/hooks/*.sh|*/.cursor/hooks/lib/*)        SURFACE="hook script" ;;
  */.cursor/schemas/subagent-returns/*.schema.json)  SURFACE="return schema" ;;
  *) exit 0 ;;
esac

# Unlock honoured (and audited).
if [ "${HEKTOR_HOOKS_UNLOCK:-0}" = "1" ]; then
  hektor_audit "enforcement layer unlocked for write: ${TARGET} (HEKTOR_HOOKS_UNLOCK=1)"
  exit 0
fi

hektor_deny "[BLOCKED — Hektor self-protection-gate] Refusing to modify the enforcement layer (${SURFACE}).

Target: ${TARGET}

The hooks, their registration in .cursor/hooks.json, and the return schemas
police this agent's own behaviour — editing them from agent context is how the
whole layer would be silently disabled. This write is denied by default.

If this is legitimate hook maintenance, set HEKTOR_HOOKS_UNLOCK=1 in the
environment for the command. The unlock is recorded in
docs/hektor/.hook-audit.log so the change is deliberate and auditable.

This gate is friction, not a security boundary — see hooks/README.md
§Vulnerabilities."
exit 0
