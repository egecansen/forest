#!/bin/bash
# observe.sh — PostToolUse capture for the capture→distill memory loop.
#
# Event   : postToolUse  (every tool call — edits AND shell)
# Mode    : non-blocking, fail-open (ALWAYS exit 0 — never wedges a tool call)
# Profile : standard, strict (skipped under `minimal` / CI)
# Env     : HEKTOR_OBSERVE=off   advisory bypass
#
# Appends one scrubbed JSON line per work-bearing tool call to
# docs/hektor/observations.jsonl. That log is the raw material for `hektor-distill`,
# which runs a cheap read-only subagent to PROPOSE MEMORY.md entries (never auto-writes).
#
# Cursor's postToolUse carries no matcher here on purpose: it fires for every
# tool, so shell commands and file edits land in the same log without needing
# the per-tool registration Claude Code required.
#
# Port of ECC skills/continuous-learning-v2/hooks/observe.sh, collapsed to its two
# load-bearing ideas — deterministic capture + a linear-time secret scrub (reused
# from lib/audit.sh hektor_redact) — dropping ECC's daemon / SIGUSR1 / confidence
# machinery (over-engineered for a single maintainer; see docs/ecc-backlog.md).
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_redact() { cat; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

[ "${HEKTOR_OBSERVE:-on}" = "off" ] && exit 0
hektor_gate_init observe "standard,strict"

ROOT="$(hektor_repo_root)"
[ -d "$ROOT/docs/hektor" ] || exit 0   # only in an initialised Hektor project

TOOL="$(hektor_tool)"; [ -n "$TOOL" ] || TOOL="?"
CWD="$(hektor_cwd)"
# A compact, secret-scrubbed slice of what this call did: the command if it was
# shell, else the file it touched, else whatever the input carried.
RAW="$(hektor_command)"
[ -n "$RAW" ] || RAW="$(hektor_file_path)"
[ -n "$RAW" ] || RAW="$(hektor_json '.tool_input | tostring')"
SLICE=$(printf '%s' "${RAW:0:800}" | hektor_redact)

TS=$(date -u +%FT%TZ 2>/dev/null || echo '?')
"$CC_JQ" -nc --arg ts "$TS" --arg tool "$TOOL" --arg cwd "$CWD" --arg input "$SLICE" \
  '{ts:$ts, tool:$tool, cwd:$cwd, input:$input}' \
  >> "$ROOT/docs/hektor/observations.jsonl" 2>/dev/null || true

# Best-effort size cap: rotate at ~5 MB (ECC observe.sh L299-306).
sz=$(wc -c < "$ROOT/docs/hektor/observations.jsonl" 2>/dev/null || echo 0)
if [ "${sz:-0}" -gt 5242880 ]; then
  tail -n 2000 "$ROOT/docs/hektor/observations.jsonl" > "$ROOT/docs/hektor/observations.jsonl.tmp" 2>/dev/null \
    && mv "$ROOT/docs/hektor/observations.jsonl.tmp" "$ROOT/docs/hektor/observations.jsonl" 2>/dev/null || true
fi
exit 0
