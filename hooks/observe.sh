#!/bin/bash
# observe.sh — PostToolUse capture for the capture→distill memory loop.
#
# Hook    : PostToolUse:Edit|Write|Bash
# Mode    : non-blocking, fail-open (ALWAYS exit 0 — never wedges a tool call)
# Profile : standard, strict (skipped under `minimal` / CI)
# Env     : HEKTOR_OBSERVE=off   advisory bypass
#
# Appends one scrubbed JSON line per work-bearing tool call to
# docs/hektor/observations.jsonl. That log is the raw material for `hektor-distill`,
# which runs a Haiku pass to PROPOSE MEMORY.md entries (it never auto-writes).
#
# Port of ECC skills/continuous-learning-v2/hooks/observe.sh, collapsed to its two
# load-bearing ideas — deterministic capture + a linear-time secret scrub (reused
# from lib/audit.sh hektor_redact) — dropping ECC's daemon / SIGUSR1 / confidence
# machinery (over-engineered for a single maintainer; see docs/ecc-backlog.md).
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ] && . "$_DIR/lib/audit.sh" || hektor_redact() { cat; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }

[ "${HEKTOR_OBSERVE:-on}" = "off" ] && exit 0
hektor_hook_enabled observe "standard,strict" || exit 0

JQ="$(command -v jq || true)"; [ -n "$JQ" ] || exit 0

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
[ -d "$ROOT/docs/hektor" ] || exit 0   # only in an initialised Hektor project

INPUT=$(head -c 1048576)   # 1 MB cap
[ -n "$INPUT" ] || exit 0

TOOL=$(printf '%s' "$INPUT" | "$JQ" -r '.tool_name // "?"' 2>/dev/null || echo "?")
CWD=$(printf '%s' "$INPUT" | "$JQ" -r '.cwd // ""' 2>/dev/null || echo "")
# A compact, secret-scrubbed slice of the tool input (command / file_path / first bytes).
RAW=$(printf '%s' "$INPUT" | "$JQ" -r '(.tool_input.command // .tool_input.file_path // (.tool_input | tostring) // "")' 2>/dev/null || echo "")
SLICE=$(printf '%s' "${RAW:0:800}" | hektor_redact)

TS=$(date -u +%FT%TZ 2>/dev/null || echo '?')
"$JQ" -nc --arg ts "$TS" --arg tool "$TOOL" --arg cwd "$CWD" --arg input "$SLICE" \
  '{ts:$ts, tool:$tool, cwd:$cwd, input:$input}' \
  >> "$ROOT/docs/hektor/observations.jsonl" 2>/dev/null || true

# Best-effort size cap: rotate at ~5 MB (ECC observe.sh L299-306).
sz=$(wc -c < "$ROOT/docs/hektor/observations.jsonl" 2>/dev/null || echo 0)
if [ "${sz:-0}" -gt 5242880 ]; then
  tail -n 2000 "$ROOT/docs/hektor/observations.jsonl" > "$ROOT/docs/hektor/observations.jsonl.tmp" 2>/dev/null \
    && mv "$ROOT/docs/hektor/observations.jsonl.tmp" "$ROOT/docs/hektor/observations.jsonl" 2>/dev/null || true
fi
exit 0
