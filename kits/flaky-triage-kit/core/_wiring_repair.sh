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
  [ -n "$_WR_LOCKDIR" ] && { rm -rf "$_WR_LOCKDIR" 2>/dev/null || true; _WR_LOCKDIR=""; }
  eval "exec ${_WR_LOCKFD}>&-" 2>/dev/null || true
  return 0
}

# _wr_lock <file> -> 0 if held, 1 if not. Mirrors core/ledger.sh's discipline (flock where present,
# portable mkdir spinlock otherwise) with two deliberate differences from ledger.sh:
#
# 1. ledger.sh DIES on timeout; this RETURNS. A lost lock means one entrypoint skips a repair the
#    next one will retry, and must not take the caller down with it.
#
# 2. ledger.sh releases via `trap 'ledger_unlock' EXIT INT TERM` — and this file MUST NOT do that.
#    _wiring_repair.sh is sourced by thirteen entrypoints through _integrity.sh; an EXIT trap
#    installed here would clobber whatever EXIT trap the sourcing entrypoint already set for its
#    OWN cleanup, the moment this file is sourced — not even at lock time. So a killed holder (a
#    Ctrl-C mid-`_wr_register`) cannot be recovered by trap. It is recovered the same way
#    core/_lock.sh's gradle_lock_acquire steals a dead gradle lock instead: the holder writes its
#    own pid into the lock directory right after acquiring it, and a contender steals the lock the
#    moment that pid is provably dead, or — a directory left by a holder that crashed BETWEEN mkdir
#    and writing its pid — once it has sat long enough that no live acquire is still in flight.
#    Proven necessary by measurement, not assumed: a pre-existing `.lock.d` with no recovery logic
#    cost every subsequent call the full 10s wait forever, on an otherwise healthy fixture — the
#    exact "must never wedge a caller" violation this file exists to prevent.
_wr_lock() {
  local target="${1:-}" waited=0 p
  [ -n "$target" ] || return 1
  if command -v flock >/dev/null 2>&1; then
    eval "exec ${_WR_LOCKFD}>\"\$target.lock\"" 2>/dev/null || return 1
    flock -w 10 "$_WR_LOCKFD" 2>/dev/null || return 1
    return 0
  fi
  until mkdir "$target.lock.d" 2>/dev/null; do
    p="$(cat "$target.lock.d/pid" 2>/dev/null || true)"          # steal if the holder is dead…
    if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; then
      rm -rf "$target.lock.d" 2>/dev/null; continue
    fi
    if [ ! -e "$target.lock.d/pid" ] && [ "$waited" -ge 40 ]; then  # …or pidless + stale (2s)
      rm -rf "$target.lock.d" 2>/dev/null; continue
    fi
    waited=$((waited + 1))
    [ "$waited" -ge 200 ] && return 1      # 200 * 0.05s = 10s cap
    sleep 0.05
  done
  echo "$$" > "$target.lock.d/pid" 2>/dev/null || true
  _WR_LOCKDIR="$target.lock.d"
  return 0
}

# _wr_register <settings-file> <command> <matcher>... -> 0 if EVERY matcher merged and was written,
# 1 if any one failed (mktemp, jq, or the mv). The caller uses this to decide whether to say
# REPAIRED — a merge that never actually landed must never be reported as one that did. Idempotent
# and additive: adds the matcher block if absent and the command inside it if absent, and touches
# nothing else in the document. Same merge install.sh performs, so an install and a repair cannot
# disagree about the shape.
_wr_register() {
  local s="$1" c="$2" m t rc=0
  shift 2
  for m in "$@"; do
    t="$(mktemp)" || { rc=1; continue; }
    if jq --arg m "$m" --arg c "$c" '
      .hooks //= {} | .hooks.PreToolUse //= [] |
      (if any(.hooks.PreToolUse[]?; .matcher==$m) then . else .hooks.PreToolUse += [{matcher:$m, hooks:[]}] end) |
      .hooks.PreToolUse |= map(if .matcher==$m then (.hooks //= []) |
        (if any(.hooks[]?; .command==$c) then . else .hooks += [{type:"command", command:$c, timeout:10}] end)
        else . end)' "$s" > "$t" 2>/dev/null && [ -s "$t" ]; then
      mv "$t" "$s" || rc=1
    else
      rm -f "$t"
      rc=1
    fi
  done
  return "$rc"
}

# _wr_register_cursor <hooks-file> <command> -> 0 on a successful merge+write, 1 otherwise. Cursor's
# spelling of the same three slots; same success/failure contract as _wr_register above.
_wr_register_cursor() {
  local s="$1" c="$2" t
  t="$(mktemp)" || return 1
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
    return 1
  fi
  return 0
}

# _wr_restore_gate <kit_root> <project_root> <tier> <harness> <dest-dir> -> 0. Narrates; never fails.
#
# Restores only where the tree is NOT root-owned. At `hardened` and `stale` the gate's path must hold
# a root-owned file — that ownership IS _wiring_one's identity test — and this process runs as the
# user, so the file it wrote would report `foreign`: the repair would break the kit differently while
# claiming to heal it. `stale` is included with `hardened` because it means the tree IS root-owned and
# only .lock-state disagrees; keying this on the recorded tier while the identity test keys on
# ownership would split one property across two conditions.
_wr_restore_gate() {
  local kit="$1" root="$2" tier="$3" harness="$4" dest="$5" src="$kit/core/gate-src/$4"
  case "$tier" in
    hardened|stale)
      echo "integrity: not restoring the $harness gate — this tree is root-owned, so a file written as you would not be the kit's. Unlock, reinstall, lock." >&2
      return 0 ;;
  esac
  if [ ! -r "$src/flaky-kit-self-protection-gate.sh" ]; then
    echo "integrity: cannot restore the $harness gate — no restore source at $src." >&2
    return 0
  fi
  mkdir -p "$dest/lib" 2>/dev/null || return 0
  cp "$src/flaky-kit-self-protection-gate.sh" "$dest/flaky-kit-self-protection-gate.sh" 2>/dev/null || return 0
  chmod +x "$dest/flaky-kit-self-protection-gate.sh" 2>/dev/null || true
  [ -r "$src/lib/audit.sh" ] && cp "$src/lib/audit.sh" "$dest/lib/audit.sh" 2>/dev/null
  echo "integrity: restored the $harness gate from the engine's copy." >&2
  return 0
}

# wiring_repair <kit_root> <tier> <wiring> -> narrates to stderr, always returns 0.
wiring_repair() {
  local kit="${1:-}" tier="${2:-}" wiring="${3:-}" root wc wu s did_c=0 did_u=0
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
    [ "$wiring" = dangling ] && _wr_restore_gate "$kit" "$root" "$tier" claude "$root/.claude/hooks"
    s="$root/.claude/settings.json"
    mkdir -p "$(dirname "$s")" 2>/dev/null
    [ -e "$s" ] || echo '{}' > "$s" 2>/dev/null
    if [ -w "$s" ] && jq -e . "$s" >/dev/null 2>&1; then
      if _wr_lock "$s"; then
        if _wr_register "$s" '"$CLAUDE_PROJECT_DIR/.claude/hooks/flaky-kit-self-protection-gate.sh"' 'Write|Edit' 'Bash'; then
          did_c=1
        else
          echo "integrity: the Claude gate registration merge failed — $s was not repaired." >&2
        fi
        _wr_unlock
      else
        echo "integrity: could not lock $s to repair the registration; the next entrypoint will retry." >&2
      fi
    else
      echo "integrity: cannot repair the registration — $s is unwritable or not parseable JSON." >&2
    fi
  fi

  if [ "$wu" = 1 ]; then
    [ "$wiring" = dangling ] && _wr_restore_gate "$kit" "$root" "$tier" cursor "$root/.cursor/hooks"
    s="$root/.cursor/hooks.json"
    mkdir -p "$(dirname "$s")" 2>/dev/null
    [ -e "$s" ] || echo '{"version":1,"hooks":{}}' > "$s" 2>/dev/null
    if [ -w "$s" ] && jq -e . "$s" >/dev/null 2>&1; then
      if _wr_lock "$s"; then
        if _wr_register_cursor "$s" '.cursor/hooks/flaky-kit-self-protection-gate.sh'; then
          did_u=1
        else
          echo "integrity: the Cursor gate registration merge failed — $s was not repaired." >&2
        fi
        _wr_unlock
      else
        echo "integrity: could not lock $s to repair the registration; the next entrypoint will retry." >&2
      fi
    else
      echo "integrity: cannot repair the registration — $s is unwritable or not parseable JSON." >&2
    fi
  fi

  [ "$did_c" = 1 ] && echo "integrity: REPAIRED — the Claude gate registration has been rewritten." >&2
  [ "$did_u" = 1 ] && echo "integrity: REPAIRED — the Cursor gate registration has been rewritten." >&2
  return 0
}
