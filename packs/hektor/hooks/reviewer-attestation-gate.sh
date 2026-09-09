#!/bin/bash
# reviewer-attestation-gate.sh — verifies a workflow-reviewer's approve verdict
#                                cites real on-disk files.
#
# Hook    : PostToolUse:Agent
# Mode    : WARN (PostToolUse can't reverse a return that already ran; we
#                 surface a systemMessage. The next run-status approval write
#                 is still gated by the actor-identity check, so the run is
#                 not advanced silently — this flags the audit trail.)
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

JQ="$(command -v jq || true)"
[ -n "$JQ" ] || exit 0   # jq absent -> fail-open

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | "$JQ" -r '.tool_name // empty' 2>/dev/null || echo "")
[ "$TOOL_NAME" = "Agent" ] || exit 0

DESCRIPTION=$(echo "$INPUT" | "$JQ" -r '.tool_input.description // ""' 2>/dev/null || echo "")
case "$DESCRIPTION" in
  workflow-reviewer-*) ;;
  *) exit 0 ;;
esac

# Flatten the reviewer's return text from the various tool_response shapes.
RESPONSE=$(echo "$INPUT" | "$JQ" -r '
  [
    (.tool_response.output? | if type == "array" then map(.text? // (.|tostring)) | join("\n") elif type == "string" then . else (.|tostring) end),
    (.tool_response.result? // empty | tostring),
    (if (.tool_response | type) == "string" then .tool_response else empty end)
  ] | map(select(. != null and . != "")) | unique | join("\n")
' 2>/dev/null || echo "")
case "$RESPONSE" in ""|"null"|"{}"|"[]") exit 0 ;; esac

# Verdict must be approve (tolerant: match `verdict: approve` / `"verdict":"approve"`).
echo "$RESPONSE" | grep -qiE 'verdict["[:space:]]*[:=]["[:space:]]*approve' || exit 0

GUARD_CWD=$(echo "$INPUT" | "$JQ" -r '.cwd // "."' 2>/dev/null || echo ".")
REPO_ROOT=$(git -C "$GUARD_CWD" rev-parse --show-toplevel 2>/dev/null || echo "$GUARD_CWD")

emit_warn() {
  "$JQ" -n --arg m "$1" '{ "systemMessage": $m, "suppressOutput": false }'
}

# Extract file-path-shaped substrings: a known project dir + a path segment,
# OR a bare filename with a project extension.
PATHS=$(printf '%s' "$RESPONSE" | grep -oE \
  '(web-ui-test|docs|src|test|\.claude|schemas|scripts)/[A-Za-z0-9_./-]+[A-Za-z0-9_]|[A-Za-z0-9_-]+\.(java|kts|json|md|xml|yaml|yml)' \
  2>/dev/null | sort -u || true)

if [ -z "$PATHS" ]; then
  emit_warn "[WARN — Hektor reviewer-attestation] workflow-reviewer approved without on-disk evidence.

Description: \"${DESCRIPTION}\"
Verdict:     approve

The return cites no project file paths. An approval that grounds its verdict in
no artifact defeats the inspector role. Expected: >=1 path under web-ui-test/,
docs/, src/, test/, or .claude/ naming a deliverable the reviewer actually read.

WARN, not DENY: PostToolUse can't reverse a return that already ran; the next
run-status approval write is still actor-identity gated. This belongs in the
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

WARN, not DENY (PostToolUse cannot reverse the return)."
fi

exit 0
