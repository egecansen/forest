#!/bin/bash
# cursor-compat.sh — Cursor hook I/O compatibility shim for the Hektor gates.
#
# Cursor's hook harness and Claude Code's hook harness disagree on two things
# the gates depend on: (1) the JSON shape on stdin, and (2) the JSON shape the
# hook prints to block / annotate. This shim normalises both so the ported gate
# scripts keep the SAME detection logic as their .claude/hooks/ originals and
# only swap their I/O boundary.
#
# Claude   stdin : { tool_name, tool_input:{command|description|prompt|file_path|
#                    content|old_string|new_string}, tool_use_id,
#                    parent_tool_use_id, cwd, tool_response }
# Claude   block : { hookSpecificOutput:{ permissionDecision:"deny",
#                    permissionDecisionReason } }
#
# Cursor   stdin : varies by event. beforeShellExecution carries `.command`;
#                  preToolUse/postToolUse carry `tool_name` + `tool_input`;
#                  field names may be snake_case or camelCase, and some payloads
#                  flatten fields to the top level. The accessors below try every
#                  known location so the gate works regardless.
# Cursor   block : { permission:"deny", agent_message, user_message }   (preToolUse,
#                  beforeShellExecution)
# Cursor   warn  : { additional_context }                               (postToolUse)
#
# Degradation: the subagent-identity checks (reviewer-approver-registry +
# run-status-write-gate Check 3) need a harness-issued tool-use id / parent id.
# If Cursor does not expose one under any known key, those accessors return ""
# and the dependent gate fails OPEN for that specific check (never wedges the
# pipeline) — same fail-open philosophy as the originals. Set HEKTOR_HOOK_DEBUG=1
# to dump raw payloads to docs/hektor/.cursor-hook-payload.log and tune the
# accessor keys against a real Cursor payload.

CC_JQ="$(command -v jq || true)"

cc_have_jq() { [ -n "$CC_JQ" ]; }

# Read stdin once into CC_INPUT. Optionally tee the raw payload for field tuning.
cc_read_input() {
  CC_INPUT=$(cat)
  if [ "${HEKTOR_HOOK_DEBUG:-0}" = "1" ]; then
    local root
    root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    if [ -d "$root/docs/hektor" ]; then
      printf '%s\t%s\t%s\n' \
        "$(date '+%FT%T%z' 2>/dev/null || echo '?')" \
        "$(basename "$0" 2>/dev/null || echo hook)" \
        "$CC_INPUT" >> "$root/docs/hektor/.cursor-hook-payload.log" 2>/dev/null || true
    fi
  fi
}

# Raw jq read against the captured input (fail-soft to "").
cc_json() { printf '%s' "$CC_INPUT" | "$CC_JQ" -r "$1" 2>/dev/null || echo ""; }

# --- normalised accessors (tolerant of nesting + naming variants) ------------
cc_tool()        { cc_json '.tool_name // .toolName // .tool // empty'; }
cc_command()     { cc_json '.command // .tool_input.command // .toolInput.command // empty'; }
cc_description() { cc_json '.tool_input.description // .toolInput.description // .description // empty'; }
cc_prompt()      { cc_json '.tool_input.prompt // .toolInput.prompt // .prompt // empty'; }
cc_subagent()    { cc_json '.tool_input.subagent_type // .toolInput.subagent_type // .subagent_type // .subagentType // empty'; }
cc_file_path()   { cc_json '.tool_input.file_path // .toolInput.file_path // .file_path // .filePath // .tool_input.filePath // .path // empty'; }
cc_content()     { cc_json '.tool_input.content // .toolInput.content // .content // empty'; }
cc_old_string()  { cc_json '.tool_input.old_string // .toolInput.old_string // .old_string // .tool_input.oldString // .oldString // empty'; }
cc_new_string()  { cc_json '.tool_input.new_string // .toolInput.new_string // .new_string // .tool_input.newString // .newString // empty'; }
cc_tool_use_id() { cc_json '.tool_use_id // .toolUseId // .tool_call_id // .toolCallId // .call_id // empty'; }
cc_parent_id()   { cc_json '.parent_tool_use_id // .parentToolUseId // .parent_tool_call_id // .parent_id // empty'; }

# Repo root from Cursor's workspace_roots, else cwd, else git, else "."
cc_repo_root() {
  local r
  r=$(cc_json '.workspace_roots[0] // .workspaceRoots[0] // .cwd // .workspace_root // empty')
  [ -z "$r" ] && r="."
  git -C "$r" rev-parse --show-toplevel 2>/dev/null || echo "$r"
}

# Flatten a subagent/tool return into plain text (postToolUse gates).
cc_response_text() {
  printf '%s' "$CC_INPUT" | "$CC_JQ" -r '
    [
      (.tool_response.output? | if type == "array" then map(.text? // (.|tostring)) | join("\n") elif type == "string" then . else (.|tostring) end),
      (.tool_response.result? // empty | tostring),
      (if (.tool_response | type) == "string" then .tool_response else empty end),
      (.tool_output? // empty | tostring),
      (.output? // empty | tostring),
      (.result? // empty | tostring)
    ] | map(select(. != null and . != "")) | unique | join("\n")
  ' 2>/dev/null || echo ""
}

# --- Cursor-format emitters ---------------------------------------------------
# Block a preToolUse / beforeShellExecution call. Caller should `exit 0` after.
cc_deny() {
  "$CC_JQ" -n --arg r "$1" '{
    "permission": "deny",
    "agent_message": $r,
    "user_message": "Blocked by a Hektor enforcement gate."
  }'
}

# Inject feedback after a tool/subagent completes (postToolUse WARN gates).
cc_warn() {
  "$CC_JQ" -n --arg m "$1" '{ "additional_context": $m }'
}
