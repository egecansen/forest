#!/bin/bash
# commit-gate.sh — Hektor commit / push enforcement.
#
# Hook    : PreToolUse:Bash  (filters to git invocations only)
# Mode    : DENY (no WARN path)
# State   : none
# Env     : HEKTOR_COMMIT_GATE=off   advisory bypass (document the authorisation)
#
# Rule
# ----
# The agent NEVER commits or pushes — the user does both manually and
# reviews the working tree first. This mirrors the project memory rule
# "NEVER commit or comment on PRs". This gate makes that binding rather
# than advisory: any `git commit` or `git push` issued from agent context
# is denied. Hook-bypass flags (--no-verify / --no-gpg-sign) are denied on
# every git command as defence-in-depth.
#
# Note on scope: PreToolUse:Bash fires only on Bash *tool* calls the model
# makes. A user running `! git commit` in the session is executed by the
# harness directly and is NOT gated — so this blocks the agent, not the
# human.
#
# Ports the enforcement half of Achilles' commit-message-gate.sh, retargeted
# from coverage-expansion commit conventions to Hektor's manual-commit rule.
#
# Failure -> action
# -----------------
# - `git commit ...`                              -> DENY (agent must not commit)
# - `git push ...`                                -> DENY (agent must not push)
# - `--no-verify` / `--no-gpg-sign` on any git cmd-> DENY (hook bypass)
# - Anything else                                 -> silent allow

set -uo pipefail

_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/audit.sh"
if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi

if [ "${HEKTOR_COMMIT_GATE:-on}" = "off" ]; then
  hektor_audit "commit-gate bypassed (HEKTOR_COMMIT_GATE=off)"
  exit 0
fi

JQ="$(command -v jq || true)"
if [ -z "$JQ" ]; then
  # jq absent: fail-open so the hook never wedges the pipeline.
  exit 0
fi

emit_deny() {
  "$JQ" -n --arg r "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $r
    }
  }'
}

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | "$JQ" -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Strip quoted regions so flags / keywords inside a -m "..." message body
# don't false-positive. Replace single- and double-quoted spans with a
# placeholder token.
CMD_SCAN=$(printf '%s' "$CMD" | sed -E "s/'[^']*'/'_MSG_'/g; s/\"[^\"]*\"/\"_MSG_\"/g")

# Hook-bypass flags on any git command.
if printf '%s' "$CMD_SCAN" | grep -qE '(^|[[:space:]])(--no-verify|--no-gpg-sign|commit\.gpgsign=false)([[:space:]]|$)'; then
  emit_deny "[BLOCKED — Hektor commit-gate] Hook/signing bypass flag detected (--no-verify / --no-gpg-sign / commit.gpgsign=false).

Bypassing hooks or signing is never the fix. Investigate the underlying issue instead.

Override (only if the user explicitly authorised it): prefix the command's environment with HEKTOR_COMMIT_GATE=off."
  exit 0
fi

# git commit.
if printf '%s' "$CMD_SCAN" | grep -qE '(^|[;&|]|&&|\|\|)[[:space:]]*git[[:space:]]+commit([[:space:]]|$)'; then
  emit_deny "[BLOCKED — Hektor commit-gate] The agent does not commit.

Project rule (memory: never-commit): the user commits and pushes manually after
reviewing the working tree. Stop at working-tree changes and hand back.

What to do: leave the edits in place and summarise what changed so the user can
review, commit, and comment themselves.

Override (only if the user explicitly asked you to commit this turn): prefix the
command with HEKTOR_COMMIT_GATE=off."
  exit 0
fi

# git push.
if printf '%s' "$CMD_SCAN" | grep -qE '(^|[;&|]|&&|\|\|)[[:space:]]*git[[:space:]]+push([[:space:]]|$)'; then
  emit_deny "[BLOCKED — Hektor commit-gate] The agent does not push.

Project rule (memory: never-commit): the user pushes manually. Hand back the
local branch state instead of pushing.

Override (only if the user explicitly asked you to push this turn): prefix the
command with HEKTOR_COMMIT_GATE=off."
  exit 0
fi

exit 0
