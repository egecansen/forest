#!/bin/bash
# destructive-command-gate.sh — block irreversible Bash that can wipe in-progress work.
#
# Event   : beforeShellExecution
# Mode    : DENY
# State   : none
# Env     : HEKTOR_DESTRUCTIVE_GATE=off   advisory bypass (document the authorisation)
#
# Why
# ---
# commit-gate stops the agent COMMITTING; this stops it silently DESTROYING the
# working tree it's supposed to hand back for review — the `rm -rf` / `git reset
# --hard` / `git clean -fd` an agent reaches for to "start clean" after a wrong
# turn, taking your uncommitted test work with it. Port of ECC governance-capture
# APPROVAL_COMMANDS (scripts/hooks/governance-capture.js:40-46). Same string-match
# shape + quote-stripping as commit-gate; same fail-open philosophy.
#
# Blocks: rm -rf · git reset --hard · git clean -f(d) · git checkout/restore of the
# whole tree ('.' / '--') · git stash clear|drop. (`git push --force` is already
# denied wholesale by commit-gate.)
set -uo pipefail

_DIR="$(dirname "${BASH_SOURCE[0]}")"
[ -f "$_DIR/lib/audit.sh" ]        && . "$_DIR/lib/audit.sh"        || hektor_audit() { :; }
[ -f "$_DIR/lib/hook_profile.sh" ] && . "$_DIR/lib/hook_profile.sh" || hektor_hook_enabled() { return 0; }
[ -f "$_DIR/lib/cursor.sh" ]       && . "$_DIR/lib/cursor.sh"       || exit 0

[ "${HEKTOR_DESTRUCTIVE_GATE:-on}" = "off" ] && { hektor_audit "destructive-command-gate bypassed (HEKTOR_DESTRUCTIVE_GATE=off)"; exit 0; }
hektor_gate_init destructive-command-gate "minimal,standard,strict"   # hard blocker: all profiles

CMD="$(hektor_command)"
[ -n "$CMD" ] || exit 0

# Strip quoted regions (so a keyword inside a -m "..." message can't false-positive),
# then strip a trailing ` # comment` (a commented rm -rf never executes). Quote-strip
# runs first, so a `#` inside a string is already neutralised.
CMD_SCAN=$(printf '%s' "$CMD" | sed -E "s/'[^']*'/'_MSG_'/g; s/\"[^\"]*\"/\"_MSG_\"/g; s/[[:space:]]#[^\"']*$//")

WHY=""
match() { printf '%s' "$CMD_SCAN" | grep -qE "$1"; }

# rm with both -r and -f (any order / combined).
if match '(^|[;&|[:space:]])rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-[rf][[:space:]]+-[rf])'; then
  WHY="rm -rf — recursive force-delete"
elif match '(^|[;&|[:space:]])git[[:space:]]+reset[[:space:]]+(--hard|--keep[[:space:]]|.*[[:space:]]--hard)'; then
  WHY="git reset --hard — discards all uncommitted changes"
elif match '(^|[;&|[:space:]])git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*f'; then
  WHY="git clean -f — deletes untracked files (new test files included)"
elif match '(^|[;&|[:space:]])git[[:space:]]+(checkout|restore)[[:space:]]+((-[a-zA-Z]+[[:space:]]+)*)?(--[[:space:]]+)?\.([[:space:]]|$)'; then
  WHY="git ${BASH_REMATCH:-checkout/restore} of the whole tree — discards working changes"
elif match '(^|[;&|[:space:]])git[[:space:]]+restore[[:space:]]+((--staged|--worktree|--source[= ][^ ]+)[[:space:]]+)*\.([[:space:]]|$)'; then
  WHY="git restore . — discards working changes"
elif match '(^|[;&|[:space:]])git[[:space:]]+stash[[:space:]]+(clear|drop)'; then
  WHY="git stash clear/drop — permanently removes stashed work"
fi

[ -n "$WHY" ] || exit 0

hektor_deny "[BLOCKED — Hektor destructive-command-gate] Refusing an irreversible command that could wipe your in-progress work.

Detected: ${WHY}
Command:  ${CMD}

The agent hands the working tree back for you to review and commit — it does not
reset or force-delete it. If you truly need this (e.g. cleaning a throwaway dir),
run it yourself, or authorise it for this command with:
  HEKTOR_DESTRUCTIVE_GATE=off <command>"
exit 0
