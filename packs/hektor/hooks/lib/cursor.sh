#!/bin/bash
# cursor.sh — the Hektor gates' I/O boundary with Cursor.
#
# Every gate sources this, then keeps its own detection logic verbatim. The only
# harness-specific things in the pack live here: how a payload is read off stdin,
# and how a verdict is printed. Nothing else in hooks/ knows what Cursor is.
#
# Input shapes differ per event — the accessors below try every field a given
# datum can arrive under, so a gate asks for "the command" or "the file path"
# without caring which event delivered it:
#
#   sessionStart          .session_id .composer_mode
#   beforeSubmitPrompt    .prompt .attachments[]
#   beforeShellExecution  .command .cwd .sandbox            <- command at TOP level
#   preToolUse            .tool_name .tool_input.* .tool_use_id
#   postToolUse           .tool_name .tool_input.* .tool_output .duration
#   afterFileEdit         .file_path .edits[]{old_string,new_string}
#   subagentStart         .subagent_type .task .tool_call_id .parent_conversation_id
#   subagentStop          .subagent_type .status .summary .modified_files[]
#   stop                  .status .loop_count
#
# Output shapes (what Cursor actually reads back):
#   permission verdict  { permission, agent_message, user_message }   deny/allow/ask
#   context injection   { additional_context }                        sessionStart, postToolUse
#   follow-up turn      { followup_message }                          stop, subagentStop
#   prompt veto         { continue, user_message }                    beforeSubmitPrompt
#
# Exit codes: 0 = use the JSON on stdout. 2 = block outright. Anything else is
# read as "the hook itself broke" and Cursor lets the action through. Every gate
# here fails OPEN — a gate that wedges the agent because jq is missing is a worse
# bug than the rule it was enforcing going unchecked for one call.
#
# Kill switches, unchanged from the pack's original contract:
#   HEKTOR_CURSOR_HOOKS=off     disable every Hektor gate
#   HEKTOR_DISABLED_HOOKS=a,b   comma list of gate ids to force off
#   HEKTOR_HOOK_PROFILE=...     minimal | standard | strict  (see hook_profile.sh)
#   HEKTOR_<GATE>=off           per-gate bypass, honoured by the gate itself

CC_JQ="$(command -v jq || true)"

# --- preflight -------------------------------------------------------------
# Call once at the top of a gate: `hektor_gate_init <gate-id> <profiles-csv>`.
# Exits 0 (allow) if the gate is switched off, jq is unavailable, or the gate is
# not in the active profile. Otherwise reads stdin into CC_INPUT and returns.
hektor_gate_init() {
  local id="$1" profiles="${2:-minimal,standard,strict}"
  [ "${HEKTOR_CURSOR_HOOKS:-on}" = "off" ] && exit 0
  case ",${HEKTOR_DISABLED_HOOKS:-}," in *",${id},"*) exit 0 ;; esac
  [ -n "$CC_JQ" ] || exit 0
  hektor_hook_enabled "$id" "$profiles" || exit 0
  hektor_read_input
}

# Read stdin once, capped, into CC_INPUT. The cap matters: afterFileEdit on a
# generated file can carry megabytes of edit strings, and every registration on
# the event gets its own copy.
hektor_read_input() {
  CC_INPUT="$(head -c 4194304)"
  if [ "${HEKTOR_HOOK_DEBUG:-0}" = "1" ]; then
    local root; root="$(hektor_repo_root)"
    mkdir -p "$root/docs/hektor" 2>/dev/null || true
    printf '%s\t%s\t%s\n' "$(date '+%FT%T%z' 2>/dev/null || echo '?')" \
      "$(basename "$0" 2>/dev/null || echo hook)" "$CC_INPUT" \
      >> "$root/docs/hektor/.cursor-hook-payload.log" 2>/dev/null || true
  fi
}

# Raw jq read against CC_INPUT, fail-soft to "".
hektor_json() { printf '%s' "$CC_INPUT" | "$CC_JQ" -r "$1" 2>/dev/null || echo ""; }

# --- accessors -------------------------------------------------------------
hektor_event()      { hektor_json '.hook_event_name // empty'; }
hektor_tool()       { hektor_json '.tool_name // empty'; }
hektor_prompt()     { hektor_json '.prompt // empty'; }
hektor_cwd()        { hektor_json '.cwd // .workspace_roots[0]? // empty'; }

# The shell command, wherever it lives. beforeShellExecution puts it at the top
# level; preToolUse nests it under tool_input.
hektor_command()    { hektor_json '.command // .tool_input.command // empty'; }

# The file being written. Cursor's edit-tool field naming has moved across
# versions (file_path / path / target_file), so try all of them rather than
# pinning to one — and deliberately do NOT gate on .tool_name, which has moved too.
hektor_file_path()  { hektor_json '.file_path // .tool_input.file_path // .tool_input.path // .tool_input.target_file // .path // empty'; }

# The content being written. `code_edit` is the partial-edit form; `new_string`
# the search/replace form; `content` the whole-file form.
hektor_content()    { hektor_json '.tool_input.content // .tool_input.code_edit // .tool_input.new_string // .content // empty'; }
hektor_old_string() { hektor_json '.tool_input.old_string // .old_string // empty'; }
hektor_new_string() { hektor_json '.tool_input.new_string // .new_string // empty'; }

# afterFileEdit delivers an array of edits. Flatten the added text so a scanner
# sees everything this call introduced, whatever form it arrived in.
hektor_added_text() {
  printf '%s' "$CC_INPUT" | "$CC_JQ" -r '
    [ (.edits[]?.new_string // empty),
      (.tool_input.content // empty),
      (.tool_input.code_edit // empty),
      (.tool_input.new_string // empty),
      (.content // empty)
    ] | map(select(. != null and . != "")) | join("\n")
  ' 2>/dev/null || echo ""
}

# subagent* accessors.
#
# Role label. Claude Code carried a short role string in the dispatch's
# `description` (composer-j-x, workflow-reviewer-phase-2, "[group] search").
# Cursor's subagentStop keeps a `description`; subagentStart does not, so the
# convention is that a Hektor dispatch names its role on the FIRST line of the
# task:
#
#     role: workflow-reviewer-phase-2
#     Read docs/hektor/run-status.json and verify ...
#
# Resolution order: explicit description -> that first line (with an optional
# `role:` prefix stripped) -> the named subagent type. Gates match against this
# exactly as they used to match against `description`, so their rules are
# unchanged.
hektor_role() {
  local d t
  d="$(hektor_json '.description // empty')"
  if [ -n "$d" ]; then printf '%s' "$d"; return 0; fi
  t="$(hektor_json '.task // empty' | sed -e '/^[[:space:]]*$/d' -e 's/^[[:space:]]*[Rr]ole:[[:space:]]*//' | head -1)"
  if [ -n "$t" ]; then printf '%s' "$t"; return 0; fi
  hektor_json '.subagent_type // empty'
}

# The full brief the subagent was dispatched with.
hektor_brief() { hektor_json '.task // empty'; }

hektor_subagent_type() { hektor_json '.subagent_type // empty'; }
hektor_subagent_task() { hektor_json '.task // empty'; }
hektor_subagent_id()   { hektor_json '.subagent_id // .tool_call_id // empty'; }
hektor_status()        { hektor_json '.status // empty'; }
hektor_summary()       { hektor_json '.summary // empty'; }
hektor_modified_files(){ hektor_json '.modified_files[]? // empty'; }
hektor_loop_count()    { hektor_json '.loop_count // 0'; }

# postToolUse output text, flattened.
hektor_tool_output() {
  printf '%s' "$CC_INPUT" | "$CC_JQ" -r '
    [ (.tool_output? | if type=="string" then . else (.|tostring) end),
      (.result_json? // empty), (.output? // empty)
    ] | map(select(. != null and . != "")) | join("\n")
  ' 2>/dev/null || echo ""
}

# Repo root: Cursor's workspace root if it gave one, else git, else cwd.
hektor_repo_root() {
  local r
  r="$(printf '%s' "${CC_INPUT:-}" | "$CC_JQ" -r '.workspace_roots[0]? // .cwd? // empty' 2>/dev/null || echo "")"
  [ -n "$r" ] && [ -d "$r" ] || r="$(pwd)"
  git -C "$r" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$r"
}

# --- emitters --------------------------------------------------------------
# Block a before*/preToolUse call. $1 = reason shown to the agent.
hektor_deny() {
  "$CC_JQ" -n --arg r "$1" '{
    permission: "deny",
    agent_message: $r,
    user_message: "Blocked by a Hektor enforcement gate."
  }'
}

# Ask the user rather than deciding. Use where a rule has legitimate exceptions.
hektor_ask() {
  "$CC_JQ" -n --arg r "$1" '{ permission: "ask", agent_message: $r, user_message: $r }'
}

# Feed text back into the conversation (sessionStart, postToolUse).
hektor_context() { "$CC_JQ" -n --arg m "$1" '{ additional_context: $m }'; }

# Make the agent take another turn (stop, subagentStop). Cursor caps repeats via
# `loop_limit` in hooks.json, so a gate that keeps failing cannot spin forever.
hektor_followup() { "$CC_JQ" -n --arg m "$1" '{ followup_message: $m }'; }

# Veto a prompt before it is sent (beforeSubmitPrompt).
hektor_block_prompt() { "$CC_JQ" -n --arg m "$1" '{ continue: false, user_message: $m }'; }
