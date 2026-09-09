#!/bin/bash
# cursor-compat.sh — Cursor hook I/O compatibility shim for the Hektor gates.
#
# This is the pack-wide version of the flaky-triage kit's cursor-compat.sh, and
# the bash equivalent of ECC's .cursor/hooks/adapter.js `transformToClaude()`
# (github.com/affaan-m/ECC). Cursor's hook harness and Claude Code's harness
# disagree on (1) the JSON shape on stdin and (2) the JSON shape a hook prints
# to block / annotate. This shim normalises both so the SAME .claude/hooks/*.sh
# gate scripts run unchanged under Cursor — only the I/O boundary is translated.
#
# Claude   stdin : { tool_name, tool_input:{command|description|prompt|file_path|
#                    content|old_string|new_string}, tool_use_id,
#                    parent_tool_use_id, cwd, tool_response }
# Claude   block : { hookSpecificOutput:{ permissionDecision:"deny",
#                    permissionDecisionReason } }
# Claude   warn  : { systemMessage }
#
# Cursor   stdin : varies by event. beforeShellExecution carries `.command`;
#                  afterFileEdit carries `.file_path`/`.path` (+ `.edits`);
#                  field names may be snake_case or camelCase, some payloads
#                  flatten to the top level. The accessors try every known key.
# Cursor   block : { permission:"deny", agent_message, user_message }
# Cursor   warn  : { additional_context }   (after* events cannot block)
#
# Degradation: subagent-identity checks need a harness-issued tool-use / parent
# id that Cursor may not expose — those accessors return "" and the dependent
# gate fails OPEN for that check (never wedges the pipeline), same fail-open
# philosophy as the Claude originals. HEKTOR_HOOK_DEBUG=1 dumps raw payloads to
# docs/hektor/.cursor-hook-payload.log to tune accessor keys against real input.

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
cc_event()       { cc_json '.hook_event_name // .hookEventName // .event // empty'; }

# Repo root from Cursor's workspace_roots, else cwd, else git, else "."
cc_repo_root() {
  local r
  r=$(cc_json '.workspace_roots[0] // .workspaceRoots[0] // .cwd // .workspace_root // empty')
  [ -z "$r" ] && r="."
  git -C "$r" rev-parse --show-toplevel 2>/dev/null || echo "$r"
}

# Flatten a subagent/tool return into plain text (post* gates).
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

# --- Claude-shape payload builder --------------------------------------------
# Build a synthetic Claude PreToolUse payload ($1 = tool_name) from the current
# Cursor input, so an UNMODIFIED .claude/hooks/*.sh gate can consume it. On an
# after-edit event the file already exists, so `content` is filled from disk to
# give a Write-shaped whole-file scan.
cc_claude_payload() {
  local tool="$1" fp content
  fp="$(cc_file_path)"
  content="$(cc_content)"
  # Read at most 1 MB, and only from a regular file (never a device/FIFO that
  # could hang or flood on a hostile afterFileEdit payload).
  if [ -z "$content" ] && [ -n "$fp" ] && [ -f "$fp" ]; then
    content="$(head -c 1048576 "$fp" 2>/dev/null || echo "")"
  fi
  "$CC_JQ" -n \
    --arg tool "$tool" \
    --arg cmd "$(cc_command)" \
    --arg fp "$fp" \
    --arg content "$content" \
    --arg old "$(cc_old_string)" \
    --arg new "$(cc_new_string)" \
    --arg desc "$(cc_description)" \
    --arg cwd "$(cc_repo_root)" '
    {
      tool_name: $tool,
      tool_input: (
        {}
        | (if $cmd     != "" then .command     = $cmd     else . end)
        | (if $fp      != "" then .file_path   = $fp      else . end)
        | (if $content != "" then .content     = $content else . end)
        | (if $old     != "" then .old_string  = $old     else . end)
        | (if $new     != "" then .new_string  = $new     else . end)
        | (if $desc    != "" then .description = $desc     else . end)
      ),
      cwd: $cwd
    }'
}

# --- Cursor-format emitters ---------------------------------------------------
# Block a before* call. Caller should `exit 0` after.
cc_deny() {
  "$CC_JQ" -n --arg r "$1" '{
    "permission": "deny",
    "agent_message": $r,
    "user_message": "Blocked by a Hektor enforcement gate."
  }'
}

# Inject feedback after a tool completes / on an after* event (advisory, no block).
cc_warn() {
  "$CC_JQ" -n --arg m "$1" '{ "additional_context": $m }'
}
