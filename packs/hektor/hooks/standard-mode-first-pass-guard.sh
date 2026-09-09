#!/bin/bash
# standard-mode-first-pass-guard.sh — first-pass strict-dispatch enforcement
#                                     for hektor-coverage-expansion.
#
# Event   : subagentStart
# Mode    : DENY (blocks the dispatch before the subagent starts)
# State   : reads (under the run's repo root)
#             docs/hektor/coverage-expansion-state.json  (primary: runMode + currentPass)
#             docs/hektor/run-status.json                (fallback: runMode + currentPhase)
# Env     : HEKTOR_FIRSTPASS_GUARD=off   advisory bypass
#
# Rule (single rule — the grouping guard)
# ---------------------------------------
# A dispatch whose role label starts with `[group]` or `[P3-batch]`
# is the section-grouped, lower-fidelity dispatch shape. Per
# hektor-coverage-expansion/SKILL.md §"Modes":
#
#   - `standard` (default): Pass 1 is strict per-journey; `[group]` is only
#     permitted on Passes 2-5.
#   - `depth`: every pass is strict per-journey; `[group]` is forbidden on
#     every pass.
#
# So DENY a `[group]` / `[P3-batch]` dispatch when:
#   (a) no coverage-expansion-state.json exists yet (implicit Pass 1), OR
#   (b) currentPass is empty or == 1 (Pass 1 under standard), OR
#   (c) runMode == "depth" (any pass).
# Otherwise silent-allow.
#
# Achilles' Rules 2 (phase4-prioritise-author) and 3 (single-agent cycle-1
# walkthrough) were journey-mapping-pipeline-specific and have no Hektor
# analogue yet — intentionally omitted. Add them if/when Hektor's
# journey-mapping grows the matching cycle-state ledger.
#
# Input-tolerant by design: malformed stdin / missing state / jq failure
# all silent-allow rather than crash the PreToolUse pipeline (no `set -e`).
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

[ "${HEKTOR_FIRSTPASS_GUARD:-on}" = "off" ] && { hektor_audit "standard-mode-first-pass-guard bypassed (HEKTOR_FIRSTPASS_GUARD=off)"; exit 0; }
hektor_gate_init standard-mode-first-pass-guard "standard,strict"

DESCRIPTION="$(hektor_role)"
[ -n "$DESCRIPTION" ] || exit 0

# Only the grouped dispatch shapes are gated.
printf '%s' "$DESCRIPTION" | grep -qE '^[[:space:]]*\[(group|P3-batch)\]' || exit 0

REPO_ROOT="$(hektor_repo_root)"
COV_STATE="$REPO_ROOT/docs/hektor/coverage-expansion-state.json"
RUN_STATUS="$REPO_ROOT/docs/hektor/run-status.json"

emit_deny() { hektor_deny "$1"; }

RUN_MODE="standard"
CURRENT_PASS=""

if [ -f "$COV_STATE" ]; then
  RAW_MODE=$("$CC_JQ" -r '.runMode // "standard"' "$COV_STATE" 2>/dev/null || echo "standard")
  [ "$RAW_MODE" = "depth" ] && RUN_MODE="depth"
  CURRENT_PASS=$("$CC_JQ" -r '.currentPass // empty' "$COV_STATE" 2>/dev/null || echo "")
  case "$CURRENT_PASS" in ''|*[!0-9]*) CURRENT_PASS="" ;; esac
elif [ -f "$RUN_STATUS" ]; then
  RAW_MODE=$("$CC_JQ" -r '.runMode // "standard"' "$RUN_STATUS" 2>/dev/null || echo "standard")
  [ "$RAW_MODE" = "depth" ] && RUN_MODE="depth"
  # Pre-coverage-expansion phases are Pass-1-equivalent (leave CURRENT_PASS empty).
fi

if [ "$RUN_MODE" = "depth" ]; then
  emit_deny "[BLOCKED — Hektor first-pass guard] Grouping is forbidden on every pass under runMode: depth.

Description: \"${DESCRIPTION}\"

depth is strict per-journey on every pass — \`[group]\` / \`[P3-batch]\` markers
are not allowed. Split this into N parallel single-journey dispatches in one
message (one hektor-test-composer per journey). If grouping is genuinely needed,
re-declare the run as runMode: standard.

See hektor-coverage-expansion/SKILL.md §\"Modes\".
Override (advisory): prefix the dispatch with HEKTOR_FIRSTPASS_GUARD=off."
  exit 0
fi

if [ -z "$CURRENT_PASS" ] || [ "$CURRENT_PASS" = "1" ]; then
  emit_deny "[BLOCKED — Hektor first-pass guard] Pass-1 grouping is forbidden under runMode: standard.

Description: \"${DESCRIPTION}\"

Pass 1 is strict per-journey by contract — \`[group]\` / \`[P3-batch]\` are only
permitted on Passes 2-5. The first pass establishes the test foundation at full
fidelity; that quality propagates to every later pass.

Fix: split into N parallel single-journey hektor-test-composer dispatches in one
message. Re-issue grouped dispatches on Pass 2+ once coverage-expansion-state.json
shows currentPass >= 2.

See hektor-coverage-expansion/SKILL.md §\"Modes\" and §\"Pass-1 dispatch\".
Override (advisory): prefix the dispatch with HEKTOR_FIRSTPASS_GUARD=off."
  exit 0
fi

# currentPass >= 2 under standard — grouping permitted.
exit 0
