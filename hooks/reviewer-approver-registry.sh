#!/bin/bash
# reviewer-approver-registry.sh — register authorised approver subagents so
#                                 the run-status-write-gate can verify WHO is
#                                 approving, not just WHAT.
#
# Event   : subagentStart
# Mode    : silent allow (registration hook — never blocks)
# State   : writes docs/hektor/.workflow-approvers.json (gitignored, TTL 30m)
# Env     : none
#
# Why
# ---
# The run-status-write-gate enforces ledger SHAPE + transition validity, but
# without an actor-identity check the orchestrator could simply Write
# `reviewerVerdict: "approved"` itself — a self-grading move that defeats the
# whole reviewer protocol (hektor-orchestrator/SKILL.md §"Refusal cases"
# references the workflow-reviewer pattern + 3-cycle reject cap).
#
# This hook opens a short-lived APPROVAL LEASE whenever an approver-prefixed
# subagent starts, keyed by Cursor's subagent_id with a 30-minute TTL.
#
# Honest note on what this can and cannot do here. On Claude Code the write-gate
# matched a proposed approval's `parent_tool_use_id` against this registry, which
# proved the approval was written from INSIDE the reviewer subagent. Cursor
# exposes no parent-call link on an ordinary tool call, so that exact attribution
# is not reconstructible. The lease keeps the load-bearing half — an approval
# cannot land unless an approver subagent actually ran, recently — and loses the
# other half: it cannot prove the write came from within that subagent rather
# than from the orchestrator while one happened to be open. Documented as a
# known degradation in docs/cursor-parity.md rather than papered over.
#
# Approver-role prefixes (the dispatch's role label):
#   workflow-reviewer-*   — the reviewer / inspector dispatch
#   phase-validator-*     — per-phase greenlight emitter
#
# Port of Achilles' workflow-approver-registry.sh, retargeted to docs/hektor/.
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

hektor_gate_init reviewer-approver-registry "standard,strict"

DESCRIPTION="$(hektor_role)"
case "$DESCRIPTION" in
  workflow-reviewer-*) APPROVER_ROLE="workflow-reviewer" ;;
  phase-validator-*)   APPROVER_ROLE="phase-validator" ;;
  *)                   exit 0 ;;
esac

AGENT_TOOL_USE_ID="$(hektor_subagent_id)"
[ -n "$AGENT_TOOL_USE_ID" ] || exit 0

REPO_ROOT="$(hektor_repo_root)"
REGISTRY_DIR="$REPO_ROOT/docs/hektor"
REGISTRY_FILE="$REGISTRY_DIR/.workflow-approvers.json"

# If docs/hektor/ doesn't exist yet, the write-gate will find no registry and
# deny any approval write — correct, you can't approve before the run starts.
[ -d "$REGISTRY_DIR" ] || exit 0

NOW=$(date +%s 2>/dev/null || echo 0)
TTL_SECONDS=1800

EXISTING="{}"
if [ -f "$REGISTRY_FILE" ]; then
  EXISTING=$(cat "$REGISTRY_FILE" 2>/dev/null || echo "{}")
  echo "$EXISTING" | "$CC_JQ" -e 'type == "object"' >/dev/null 2>&1 || EXISTING="{}"
fi

UPDATED=$(echo "$EXISTING" | "$CC_JQ" -c \
  --arg id "$AGENT_TOOL_USE_ID" \
  --arg role "$APPROVER_ROLE" \
  --arg desc "$DESCRIPTION" \
  --argjson now "$NOW" \
  --argjson ttl "$TTL_SECONDS" \
  '
    . as $reg
    | reduce keys[] as $k ({};
        if ($reg[$k].ts // 0) >= ($now - $ttl)
          then . + { ($k): $reg[$k] }
          else .
        end)
    | . + { ($id): { role: $role, description: $desc, ts: $now } }
  ' 2>/dev/null || echo "")

if [ -n "$UPDATED" ]; then
  TMP="$REGISTRY_FILE.tmp.$$"
  echo "$UPDATED" > "$TMP" 2>/dev/null && mv "$TMP" "$REGISTRY_FILE" 2>/dev/null || rm -f "$TMP" 2>/dev/null || true
fi

exit 0
