#!/bin/bash
# core/_wiring_repair.sh — the kit re-asserts its own gate registration.
#
# Detection alone was not enough. Whether a project ends up wired depends on which tool provisioned
# it, and a worktree was twice observed holding this kit with none of it wired and nothing saying
# why. So when the kit runs at all, its own wiring is its own responsibility.
#
# This unit is the ONLY place in the integrity path that writes. `_integrity.sh` stays a detector —
# thirteen entrypoints source it under a contract that it never wedges a caller — and mixing a
# filesystem mutation into that would blur the one property those entrypoints rely on.
#
# Every failure mode here resolves to doing nothing and saying why. A repair that cannot run must
# never abort a triage.

_WR_LOCKFD="201"
_WR_LOCKDIR=""

_wr_unlock() {
  [ -n "$_WR_LOCKDIR" ] && { rmdir "$_WR_LOCKDIR" 2>/dev/null || true; _WR_LOCKDIR=""; }
  eval "exec ${_WR_LOCKFD}>&-" 2>/dev/null || true
  return 0
}

# _wr_lock <file> -> 0 if held, 1 if not. Mirrors core/ledger.sh's discipline (flock where present,
# portable mkdir spinlock otherwise) with one deliberate difference: ledger.sh dies on timeout and
# this RETURNS. A lost lock means one entrypoint skips a repair the next one will retry; it must not
# take the caller down with it.
_wr_lock() {
  local target="${1:-}" waited=0
  if command -v flock >/dev/null 2>&1; then
    eval "exec ${_WR_LOCKFD}>\"\$target.lock\"" 2>/dev/null || return 1
    flock -w 10 "$_WR_LOCKFD" 2>/dev/null || return 1
    return 0
  fi
  until mkdir "$target.lock.d" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -ge 200 ] && return 1      # 200 * 0.05s = 10s cap
    sleep 0.05
  done
  _WR_LOCKDIR="$target.lock.d"
  return 0
}

# _wr_register <settings-file> <command> <matcher>... -> 0. Idempotent and additive: adds the matcher
# block if absent and the command inside it if absent, and touches nothing else in the document.
# Same merge install.sh performs, so an install and a repair cannot disagree about the shape.
_wr_register() {
  local s="$1" c="$2" m t
  shift 2
  for m in "$@"; do
    t="$(mktemp)" || return 0
    if jq --arg m "$m" --arg c "$c" '
      .hooks //= {} | .hooks.PreToolUse //= [] |
      (if any(.hooks.PreToolUse[]?; .matcher==$m) then . else .hooks.PreToolUse += [{matcher:$m, hooks:[]}] end) |
      .hooks.PreToolUse |= map(if .matcher==$m then (.hooks //= []) |
        (if any(.hooks[]?; .command==$c) then . else .hooks += [{type:"command", command:$c, timeout:10}] end)
        else . end)' "$s" > "$t" 2>/dev/null && [ -s "$t" ]; then
      mv "$t" "$s"
    else
      rm -f "$t"
    fi
  done
  return 0
}

# _wr_register_cursor <hooks-file> <command> -> 0. Cursor's spelling of the same three slots.
_wr_register_cursor() {
  local s="$1" c="$2" t
  t="$(mktemp)" || return 0
  if jq --arg c "$c" '
    .hooks //= {} |
    .hooks.beforeShellExecution //= [] |
    (if any(.hooks.beforeShellExecution[]?; .command==$c) then . else .hooks.beforeShellExecution += [{command:$c, timeout:10}] end) |
    .hooks.preToolUse //= [] |
    (if any(.hooks.preToolUse[]?; .command==$c) then . else .hooks.preToolUse += [{command:$c, matcher:"Write|Edit", timeout:10}] end)
  ' "$s" > "$t" 2>/dev/null && [ -s "$t" ]; then
    mv "$t" "$s"
  else
    rm -f "$t"
  fi
  return 0
}

# wiring_repair <kit_root> <tier> <wiring> -> narrates to stderr, always returns 0.
wiring_repair() {
  local kit="${1:-}" tier="${2:-}" wiring="${3:-}" root wc wu s did=0
  case "$wiring" in
    unregistered|partial|dangling) : ;;
    *) return 0 ;;                      # wired, absent, foreign: nothing to do or nothing that is ours
  esac
  root="$(integrity_project_root "$kit")"
  [ -n "$root" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  set -- $(_wiring_want "$kit" "$root")
  wc="${1:-0}"; wu="${2:-0}"

  if [ "$wc" = 1 ]; then
    s="$root/.claude/settings.json"
    [ -e "$s" ] || echo '{}' > "$s" 2>/dev/null
    if [ -w "$s" ] && jq -e . "$s" >/dev/null 2>&1; then
      if _wr_lock "$s"; then
        _wr_register "$s" '"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh"' 'Write|Edit' 'Bash'
        _wr_unlock
        did=1
      else
        echo "integrity: could not lock $s to repair the registration; the next entrypoint will retry." >&2
      fi
    else
      echo "integrity: cannot repair the registration — $s is unwritable or not parseable JSON." >&2
    fi
  fi

  if [ "$wu" = 1 ]; then
    s="$root/.cursor/hooks.json"
    [ -e "$s" ] || echo '{"version":1,"hooks":{}}' > "$s" 2>/dev/null
    if [ -w "$s" ] && jq -e . "$s" >/dev/null 2>&1; then
      if _wr_lock "$s"; then
        _wr_register_cursor "$s" '.cursor/hooks/flaky-kit-self-protection-gate.sh'
        _wr_unlock
        did=1
      else
        echo "integrity: could not lock $s to repair the registration; the next entrypoint will retry." >&2
      fi
    else
      echo "integrity: cannot repair the registration — $s is unwritable or not parseable JSON." >&2
    fi
  fi

  [ "$did" = 1 ] && echo "integrity: REPAIRED — the kit's gate registration has been rewritten." >&2
  return 0
}
