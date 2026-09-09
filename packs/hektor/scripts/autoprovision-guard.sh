#!/bin/bash
# autoprovision-guard.sh — make every worktree Hektor-capable the moment a
# session opens in it.
#
# Register at USER level (not project level), because a freshly created worktree
# has no .cursor/ and no .claude/ — a project-level hook cannot fire in the very
# tree that needs fixing. User-level hooks fire everywhere:
#
#   Cursor       ~/.cursor/hooks.json      -> "sessionStart"
#   Claude Code  ~/.claude/settings.json   -> "SessionStart"
#
# WHY THIS EXISTS
# ---------------
# Worktrees are created by forest (a dashboard, no post-create hook) and by
# hektor-multi-ticket. Only the latter provisions. The rest were born bare: no
# rule to route a prompt, no gate to fire, no CLAUDE.md, no gradle wrapper — and
# nothing said so. A session in such a tree behaves like Hektor does not exist,
# which is exactly what it looks like from the chat window.
#
# Fail-open by construction: any doubt and it exits 0 silently. It never blocks
# a session, and it never touches a tree that already has the kernel rule.
#
# Env:
#   HEKTOR_AUTOPROVISION=off   disable entirely
#   HEKTOR_AUTOPROVISION=warn  detect and report, but do not install
set -uo pipefail

[ "${HEKTOR_AUTOPROVISION:-on}" = "off" ] && exit 0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACK="$(cd "$HERE/.." && pwd)"
PROVISION="$HERE/worktree-provision.sh"

INPUT="$(cat 2>/dev/null || true)"
EVENT=""; ROOT=""
if command -v jq >/dev/null 2>&1 && [ -n "$INPUT" ]; then
  EVENT="$(printf '%s' "$INPUT" | jq -r '.hook_event_name // .hookEventName // empty' 2>/dev/null)"
  ROOT="$(printf '%s' "$INPUT" | jq -r '.workspace_roots[0]? // .cwd // empty' 2>/dev/null)"
fi
[ -n "$ROOT" ] || ROOT="$PWD"
[ -d "$ROOT" ] || exit 0
ROOT="$(cd "$ROOT" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || echo "$ROOT")"

# Only this project. A worktree of some other repo is none of our business.
[ -d "$ROOT/web-ui-test" ] || exit 0
# Already provisioned: the kernel rule is the single load-bearing artefact —
# without it Cursor has nothing to route with, and with it everything else was
# installed alongside.
[ -f "$ROOT/.cursor/rules/hektor-kernel.mdc" ] && exit 0

emit() {  # $1 = message, rendered for whichever harness asked
  case "$EVENT" in
    SessionStart)
      jq -n --arg c "$1" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}' 2>/dev/null ;;
    *)
      jq -n --arg c "$1" '{additional_context:$c}' 2>/dev/null ;;
  esac
}

NAME="$(basename "$ROOT")"
if [ "${HEKTOR_AUTOPROVISION:-on}" = "warn" ] || [ ! -x "$PROVISION" ]; then
  emit "Hektor is NOT installed in this worktree ($NAME): no kernel rule, no skills, no gates. Nothing will route a Jira ticket or a flaky report here. Install it with:  bash $PROVISION --reuse --no-fetch --path $ROOT --repo <main-checkout>"
  exit 0
fi

# The primary checkout is the first row of `git worktree list`; it is the tree
# that holds the local-only files (CLAUDE.md, gradle wrapper) a worktree needs.
MAIN="$(git -C "$ROOT" worktree list 2>/dev/null | head -1 | awk '{print $1}')"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ -n "$MAIN" ] || exit 0

LOG="$(mktemp 2>/dev/null || echo /tmp/hektor-autoprovision.log)"
# MCP lives at USER level (~/.cursor/mcp.json) so it is already present in every
# window — no per-project copy. Say so only when it is actually missing, rather
# than sending the reader to run a script they do not need.
MCP_NOTE=""
if ! grep -q '"Atlassian"' "$HOME/.cursor/mcp.json" 2>/dev/null; then
  MCP_NOTE=" NOTE: ~/.cursor/mcp.json has no Atlassian server, so hektor-from-jira cannot fetch a ticket — run  python3 $PACK/scripts/port-mcp-user.py"
fi

if bash "$PROVISION" --reuse --no-fetch --path "$ROOT" --repo "$MAIN" \
     ${BRANCH:+--branch "$BRANCH"} > "$LOG" 2>&1; then
  emit "Hektor was missing from this worktree ($NAME) and has just been provisioned automatically: skills, the always-applied kernel rule, the enforcement gates, CLAUDE.md/AGENTS.md and the gradle wrapper are now in place. Reload the window so the skills and hooks load.$MCP_NOTE"
else
  emit "Hektor is missing from this worktree ($NAME) and auto-provisioning FAILED. Nothing here will route a ticket or gate a write. Log: $LOG . Re-run by hand: bash $PROVISION --reuse --no-fetch --path $ROOT --repo $MAIN"
fi
exit 0
