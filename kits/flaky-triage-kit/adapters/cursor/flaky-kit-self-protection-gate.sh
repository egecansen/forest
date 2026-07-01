#!/bin/bash
# flaky-kit-self-protection-gate.sh — Hektor flaky-triage kit self-protection (Cursor port).
#
# Hook  : beforeShellExecution (Bash)  +  preToolUse matcher Write|Edit
# Mode  : DENY
# Env   : HEKTOR_FLAKYKIT_UNLOCK=1  required to modify the kit's own safety surface
#
# Cursor port of .claude/skills/hektor-flaky-triage/hooks/flaky-kit-self-protection-gate.sh — SAME
# detection logic (including the shared core/shell-guard.py quote/subshell-aware Bash check), Cursor I/O
# via cursor-compat.sh. Protects core/ + hooks/ + SKILL.md from silent self-modification.
#
# NOTE: Cursor exposes no reliable before-file-edit block, so the Write|Edit branch is best-effort. The
# OS-level wall that holds in EVERY harness (and against interpreter/compiled writers) is `core/lock-kit.sh lock`.
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
_AUDIT="$_DIR/lib/audit.sh"
if [ -f "$_AUDIT" ]; then . "$_AUDIT"; else hektor_audit() { :; }; fi
_COMPAT="$_DIR/lib/cursor-compat.sh"
if [ -f "$_COMPAT" ]; then . "$_COMPAT"; else exit 0; fi

cc_have_jq || exit 0   # jq absent -> fail-open
cc_read_input

# Patterns mirror the Claude gate's bash-ERE prefilter (kept in sync with core/shell-guard.py's python flavor).
SURF_RE='\.claude/skills/hektor-flaky-triage/(core/|hooks/[^[:space:]]*\.sh|SKILL\.md)'
MUT_RE='(>>?|[[:space:]]tee[[:space:]]|sed[[:space:]]+-i|(^|[;&|[:space:]])(cp|mv|rm|chmod|chown|truncate|dd|install|ln)([[:space:]]|$))'

CMD="$(cc_command)"
FP="$(cc_file_path)"

if [ -n "$CMD" ]; then
  # beforeShellExecution: cheap prefilter, then the shared quote/subshell-aware surface-write check.
  printf '%s' "$CMD" | grep -qE "$SURF_RE" || exit 0
  REPO="$(cc_repo_root)"
  GUARD="$REPO/.claude/skills/hektor-flaky-triage/core/shell-guard.py"
  if command -v python3 >/dev/null 2>&1 && [ -f "$GUARD" ]; then
    printf '%s' "$CMD" | python3 "$GUARD" || exit 0
  else
    printf '%s' "$CMD" | grep -qE "$MUT_RE" || exit 0
  fi
  SURFACE="kit safety surface (Bash write)"; TARGET="$CMD"
elif [ -n "$FP" ]; then
  case "$FP" in
    */.claude/skills/hektor-flaky-triage/core/*)     SURFACE="kit core (invariant logic + config)" ;;
    */.claude/skills/hektor-flaky-triage/hooks/*.sh) SURFACE="kit protection hook" ;;
    */.claude/skills/hektor-flaky-triage/SKILL.md)   SURFACE="kit skill prompt" ;;
    *) exit 0 ;;
  esac
  TARGET="$FP"
else
  exit 0
fi

# Unlock honoured (and audited) — same human-consent flag as the Claude gate + lock-kit.sh.
if [ "${HEKTOR_FLAKYKIT_UNLOCK:-0}" = "1" ]; then
  hektor_audit "flaky-triage kit safety surface unlocked for write (Cursor): ${TARGET} (HEKTOR_FLAKYKIT_UNLOCK=1)"
  exit 0
fi

cc_deny "[BLOCKED — flaky-kit self-protection-gate] Refusing to modify the flaky-triage kit's safety surface (${SURFACE}).

Target: ${TARGET}

The kit's core/ scripts, config, and SKILL.md encode its safety invariants (input sanitization,
working-tree isolation, caps, the never-commit/ticket/disable rules, the data-not-instructions
discipline). Editing them from agent context — e.g. via a misclassification or a prompt injection
carried in untrusted report / qagent / Confluence text — is how the kit would be silently weakened.

If this is legitimate kit maintenance, set HEKTOR_FLAKYKIT_UNLOCK=1 in the environment for the command.
The unlock is recorded in docs/hektor/.hook-audit.log. For an OS-level wall, run: core/lock-kit.sh lock."
exit 0
