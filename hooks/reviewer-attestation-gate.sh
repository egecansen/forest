#!/bin/bash
# reviewer-attestation-gate.sh — verifies a workflow-reviewer's approve verdict
#                                cites real on-disk files.
#
# Event   : subagentStop
# Mode    : FOLLOW-UP (the return already ran and cannot be reversed, so the
#                 gate makes the parent take another turn with the finding.
#                 Cursor caps repeats via `loop_limit` in hooks.json, so a
#                 persistent finding costs one extra turn, never a loop.)
# State   : reads the cited paths against the filesystem (read-only)
# Env     : none
#
# Why
# ---
# A reviewer (or a manipulated brief) could return `verdict: approve` /
# `attestation: "all good"` with no grounding. This hook checks the evidence
# trail: if the verdict is approve, the return text must mention >=1 project
# file-path-shaped substring, and every such path must exist on disk.
#
# Dependency-free: parses the raw return text with grep (no node/yaml). Port
# of Achilles' workflow-reviewer-attestation-gate.sh, retargeted to this repo's
# directory vocabulary.
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

hektor_gate_init reviewer-attestation-gate "strict"

DESCRIPTION="$(hektor_role)"
case "$DESCRIPTION" in
  workflow-reviewer-*) ;;
  *) exit 0 ;;
esac

# The reviewer's return text.
RESPONSE="$(hektor_summary)"
case "$RESPONSE" in ""|"null"|"{}"|"[]") exit 0 ;; esac

# Verdict must be approve (tolerant: `verdict: approve` / `"verdict":"approve"`).
printf '%s' "$RESPONSE" | grep -qiE 'verdict["[:space:]]*[:=]["[:space:]]*approve' || exit 0

REPO_ROOT="$(hektor_repo_root)"

emit_warn() { hektor_followup "$1"; }

# Extract file-path-shaped substrings: a known project dir + a path segment,
# OR a bare filename with a project extension.
PATHS=$(printf '%s' "$RESPONSE" | grep -oE \
  '(web-ui-test|docs|src|test|\.cursor|schemas|scripts)/[A-Za-z0-9_./-]+[A-Za-z0-9_]|[A-Za-z0-9_-]+\.(java|kts|json|md|xml|yaml|yml)' \
  2>/dev/null | sort -u || true)

if [ -z "$PATHS" ]; then
  emit_warn "[WARN — Hektor reviewer-attestation] workflow-reviewer approved without on-disk evidence.

Description: \"${DESCRIPTION}\"
Verdict:     approve

The return cites no project file paths. An approval that grounds its verdict in
no artifact defeats the inspector role. Expected: >=1 path under web-ui-test/,
docs/, src/, test/, or .cursor/ naming a deliverable the reviewer actually read.

A follow-up rather than a block: the return already ran and cannot be reversed;
the next run-status approval write is still lease-gated. This belongs in the
audit trail."
  exit 0
fi

MISSING=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ -e "$p" ] || [ -e "$REPO_ROOT/$p" ]; then continue; fi
  MISSING="${MISSING}
  - ${p}"
done <<< "$PATHS"

if [ -n "$MISSING" ]; then
  emit_warn "[WARN — Hektor reviewer-attestation] approval cites paths that do not exist on disk.

Description: \"${DESCRIPTION}\"
Verdict:     approve
Repo root:   ${REPO_ROOT}

Cited but missing:${MISSING}

The reviewer claims to have verified artifacts that aren't on disk — a fabricated
or mistyped attestation. The audit trail is unreliable. Recommend re-dispatching
the reviewer with a corrected evidence trail, or auditing manually.

A follow-up rather than a block — subagentStop cannot reverse the return."
fi

exit 0
