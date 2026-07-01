#!/bin/bash
# reviewer-approver-registry.sh — register authorised approver subagents so
#                                 the run-status-write-gate can verify WHO is
#                                 approving, not just WHAT.
#
# Hook    : PreToolUse:Agent
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
# This hook records every approver-prefixed Agent dispatch by tool_use_id.
# The write-gate cross-references a proposed approval write's
# parent_tool_use_id against this registry; only registered subagents can
# land an approval.
#
# Approver-role prefixes (the Agent `description`):
#   workflow-reviewer-*   — the reviewer / inspector dispatch
#   phase-validator-*     — per-phase greenlight emitter
#
# Port of Achilles' workflow-approver-registry.sh, retargeted to docs/hektor/.
set -uo pipefail

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0   # jq absent -> fail-open

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
[ "$TOOL_NAME" = "Agent" ] || exit 0

DESCRIPTION=$(echo "$INPUT" | "$JQ" -r '.tool_input.description // ""' 2>/dev/null || echo "")
case "$DESCRIPTION" in
  workflow-reviewer-*) APPROVER_ROLE="workflow-reviewer" ;;
  phase-validator-*)   APPROVER_ROLE="phase-validator" ;;
  *)                   exit 0 ;;
esac

AGENT_TOOL_USE_ID=$(echo "$INPUT" | "$JQ" -r '.tool_use_id // empty' 2>/dev/null || echo "")
[ -n "$AGENT_TOOL_USE_ID" ] || exit 0

GUARD_CWD=$(echo "$INPUT" | "$JQ" -r '.cwd // "."' 2>/dev/null || echo ".")
REPO_ROOT=$(git -C "$GUARD_CWD" rev-parse --show-toplevel 2>/dev/null || echo "$GUARD_CWD")
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
  echo "$EXISTING" | "$JQ" -e 'type == "object"' >/dev/null 2>&1 || EXISTING="{}"
fi

UPDATED=$(echo "$EXISTING" | "$JQ" -c \
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
