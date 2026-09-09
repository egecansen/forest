#!/bin/bash
# adapter.sh — Cursor→Claude hook adapter (bash port of ECC's .cursor/hooks/adapter.js).
#
# Runs an UNMODIFIED Hektor Claude gate (.claude/hooks/<gate>.sh) under Cursor:
# reads Cursor's stdin, transforms it into the Claude tool-call JSON the gate
# expects (via cursor-compat.sh), pipes it through the gate, then translates the
# gate's Claude-style verdict back into Cursor's block/warn shape.
#
#   Cursor event            -> synthesize Claude tool  -> block?
#   beforeShellExecution        Bash                       yes (cc_deny)
#   afterFileEdit               Write (whole file)         no  (cc_warn — Cursor
#                                                          has no reliable pre-edit block)
#
# So the SAME gate logic lives once in .claude/hooks/; this shim only translates
# the I/O boundary and the pre/post block semantics. Single source of truth.
#
# Usage (from .cursor/hooks.json):
#   bash .cursor/hooks/adapter.sh --gate pr-rules-gate.sh --tool Write --mode post
#   bash .cursor/hooks/adapter.sh --gate commit-gate.sh   --tool Bash  --mode pre
#
# Env:
#   HEKTOR_CURSOR_HOOKS=off        disable ALL Cursor gate adaptation (fail-open)
#   HEKTOR_DISABLED_HOOKS=a,b      comma list of gate script names to skip
#   (per-gate kill switches like HEKTOR_PR_RULES_GATE=off are honoured by the
#    gate itself, unchanged.)
set -uo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_COMPAT="$_DIR/lib/cursor-compat.sh"
[ -f "$_COMPAT" ] && . "$_COMPAT" || exit 0

GATE=""; TOOL="Write"; MODE="post"
while [ $# -gt 0 ]; do
  case "$1" in
    --gate) GATE="${2:-}"; shift 2 ;;
    --tool) TOOL="${2:-Write}"; shift 2 ;;
    --mode) MODE="${2:-post}"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$GATE" ] || exit 0
# Defence-in-depth: --gate must be a bare *.sh filename, never a path. Stops a
# malformed/compromised registration from running a script outside .claude/hooks/.
case "$GATE" in */*|*..*) exit 0 ;; esac
case "$GATE" in *.sh) ;; *) exit 0 ;; esac

# Global + per-gate disable (ECC ECC_HOOK_PROFILE/ECC_DISABLED_HOOKS analogue).
[ "${HEKTOR_CURSOR_HOOKS:-on}" = "off" ] && exit 0
case ",${HEKTOR_DISABLED_HOOKS:-}," in *",${GATE},"*) exit 0 ;; esac

cc_have_jq || exit 0   # jq absent -> fail-open
cc_read_input

# The gate lives in the sibling .claude/hooks/ tree (…/.cursor/hooks/ -> …/.claude/hooks/).
PROJ="$(cd "$_DIR/../.." && pwd)"
GATE_PATH="$PROJ/.claude/hooks/$GATE"
[ -f "$GATE_PATH" ] || exit 0

# Transform Cursor stdin -> Claude payload, run the unmodified gate.
PAYLOAD="$(cc_claude_payload "$TOOL")"
OUT="$(printf '%s' "$PAYLOAD" | bash "$GATE_PATH" 2>/dev/null || true)"
[ -n "$OUT" ] || exit 0   # gate allowed silently

# Translate the Claude-style verdict.
DECISION="$(printf '%s' "$OUT" | "$CC_JQ" -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null || echo "")"
REASON="$(printf '%s' "$OUT" | "$CC_JQ" -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null || echo "")"
SYSMSG="$(printf '%s' "$OUT" | "$CC_JQ" -r '.systemMessage // empty' 2>/dev/null || echo "")"

if [ "$DECISION" = "deny" ]; then
  if [ "$MODE" = "pre" ]; then
    cc_deny "$REASON"          # before* event: real block
  else
    cc_warn "$REASON

(Cursor cannot block an edit after the fact — this is advisory. Fix it before opening the PR; the same rule BLOCKS on Claude Code and on the server-side reviewer.)"
  fi
  exit 0
fi

if [ -n "$SYSMSG" ]; then
  cc_warn "$SYSMSG"
  exit 0
fi

exit 0
