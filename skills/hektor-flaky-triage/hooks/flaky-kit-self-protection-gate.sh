#!/bin/bash
# flaky-kit-self-protection-gate.sh — stops the gated party (incl. the
#   hektor-flaky-triage skill itself) from silently weakening the kit's
#   own safety logic.
#
# Hook    : PreToolUse:Write|Edit|Bash
# Mode    : DENY
# State   : none
# Env     : HEKTOR_FLAKYKIT_UNLOCK=1   required to edit the kit's safety surface
#
# Why
# ---
# The flaky-triage kit encodes its safety invariants (I1 sanitize, I3 working-tree
# isolation, I6 caps, the config seam, the data-not-instructions discipline) in
# its `core/` scripts, its `config.json`, and its `SKILL.md`. Those are editable
# by the same agent the kit constrains — so a misclassification, a prompt
# injection (kernel.md §Packaging P1), or plain drift could neuter the kit with
# one Edit (P2/P4). This gate denies Write/Edit to the kit's safety surface:
#   - .claude/skills/hektor-flaky-triage/core/**        (invariant logic + config)
#   - .claude/skills/hektor-flaky-triage/hooks/*.sh     (this gate — protect the protector)
#   - .claude/skills/hektor-flaky-triage/SKILL.md       (the skill prompt + safety rules)
#
# Mirrors .claude/hooks/enforcement-self-protection-gate.sh. This is FRICTION,
# not a wall — this harness doesn't honor PreToolUse `deny`, and the unlock is
# settable — the point is to convert casual / injected self-modification into a
# deliberate, audited act. It now also matches Bash commands that mutate the
# surface (redirect / sed -i / cp / mv / rm / chmod), closing the Write|Edit-only
# gap heuristically. The REAL wall (an OS read-only bit) is `core/lock-kit.sh`,
# also keyed to HEKTOR_FLAKYKIT_UNLOCK. Legitimate kit maintenance sets the unlock
# flag; the use is logged to docs/hektor/.hook-audit.log.
#
# Failure -> action
# -----------------
# - Write/Edit to the kit safety surface, unlock NOT set  -> DENY
# - Same, with HEKTOR_FLAKYKIT_UNLOCK=1                    -> ALLOW (audited)
# - Anything else                                         -> silent allow
set -uo pipefail

_LIB="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}/.claude/hooks/lib/audit.sh"
if [ -f "$_LIB" ]; then . "$_LIB"; else hektor_audit() { :; }; fi

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")

# Surface = the kit's invariant logic, config, protection hooks, and skill prompt.
SURF_RE='\.claude/skills/hektor-flaky-triage/(core/|hooks/[^[:space:]]*\.sh|SKILL\.md)'
# Bash mutation indicators (redirect / in-place / copy / move / delete / perm) — heuristic, errs toward flagging.
MUT_RE='(>>?|[[:space:]]tee[[:space:]]|sed[[:space:]]+-i|(^|[;&|[:space:]])(cp|mv|rm|chmod|chown|truncate|dd|install|ln)([[:space:]]|$))'

case "$TOOL_NAME" in
  Write|Edit)
    TARGET=$(echo "$INPUT" | "$JQ" -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
    [ -n "$TARGET" ] || exit 0
    # Is the target on the kit's safety surface?
    case "$TARGET" in
      */.claude/skills/hektor-flaky-triage/core/*)     SURFACE="kit core (invariant logic + config)" ;;
      */.claude/skills/hektor-flaky-triage/hooks/*.sh) SURFACE="kit protection hook" ;;
      */.claude/skills/hektor-flaky-triage/SKILL.md)   SURFACE="kit skill prompt" ;;
      *) exit 0 ;;
    esac ;;
  Bash)
    # Bash file-writes bypass the Write|Edit matcher — close that gap. Flag only when a command both
    # TOUCHES the surface AND MUTATES it (a read like `cat core/x.sh` passes through untouched).
    CMDSTR=$(echo "$INPUT" | "$JQ" -r '.tool_input.command // empty' 2>/dev/null || echo "")
    [ -n "$CMDSTR" ] || exit 0
    # cheap prefilter: no surface reference anywhere → not our concern (fast path, no python spawn)
    printf '%s' "$CMDSTR" | grep -qE "$SURF_RE" || exit 0
    # precise, quote/subshell-aware decision via core/shell-guard.py (the SAME helper the Cursor
    # adapter uses — write-once). Fail-open to the whole-string MUT grep if python3/helper absent.
    GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")/../core" 2>/dev/null && pwd)/shell-guard.py"
    if command -v python3 >/dev/null 2>&1 && [ -f "$GUARD" ]; then
      printf '%s' "$CMDSTR" | python3 "$GUARD" || exit 0
    else
      printf '%s' "$CMDSTR" | grep -qE "$MUT_RE" || exit 0
    fi
    SURFACE="kit safety surface (Bash write)"; TARGET="$CMDSTR" ;;
  *) exit 0 ;;
esac

# Unlock honoured (and audited).
if [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ]; then
  hektor_audit "flaky-triage kit safety surface unlocked for write: ${TARGET} (HEKTOR_FLAKYKIT_UNLOCK=1)"
  exit 0
fi

"$JQ" -n --arg r "[BLOCKED — flaky-kit self-protection-gate] Refusing to modify the flaky-triage kit's safety surface (${SURFACE}).

Target: ${TARGET}

The kit's core/ scripts, config, and SKILL.md encode its safety invariants
(input sanitization, working-tree isolation, caps, the never-commit/ticket/disable
rules, the data-not-instructions discipline). Editing them from agent context —
e.g. via a misclassification or a prompt injection carried in untrusted report /
qagent / Confluence text — is how the kit would be silently weakened. Denied by
default.

If this is legitimate kit maintenance, set HEKTOR_FLAKYKIT_UNLOCK=1 in the
environment for the command. The unlock is recorded in docs/hektor/.hook-audit.log
so the change is deliberate and auditable.

This gate is friction, not a security boundary — see
docs/hektor/flaky-triage-kit/kernel.md §Packaging threat model (P2/P4)." '{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": $r
  }
}'
exit 0
