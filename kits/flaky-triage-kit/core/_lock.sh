#!/bin/bash
# core/_lock.sh — portable cross-process gradle serialization (macOS-safe; no flock).
#
# Why: gradle invocations on ONE working copy fight over build/classes — concurrent
# `--rerun-tasks` runs delete each other's outputs ("Unable to delete directory … a process
# has files open") → a BUILD FAILED that masquerades as an anomalous/empty test verdict
# (observed s4-flaky-1394: 2 wasted cycles). Source this and wrap the gradle call:
#   . "$HERE/_lock.sh"; gradle_lock_acquire "$REPO/$WD"   # auto-released on script exit
# Same working copy → one gradle at a time. Different repos don't contend (keyed by path).
_GRADLE_LOCK_DIR=""
gradle_lock_release(){ [ -n "${_GRADLE_LOCK_DIR:-}" ] && rm -rf "$_GRADLE_LOCK_DIR" 2>/dev/null; _GRADLE_LOCK_DIR=""; }
gradle_lock_acquire(){ # $1 = working-copy path (lock key); waits, steals dead/stale locks, 30m cap
  local base="${TMPDIR:-/tmp}/hektor-flaky-rerun"; mkdir -p "$base"
  local key; key="$(printf '%s' "${1:-$PWD}" | cksum | cut -d' ' -f1)"
  _GRADLE_LOCK_DIR="$base/.gradle.$key.lock"
  local waited=0 p
  until mkdir "$_GRADLE_LOCK_DIR" 2>/dev/null; do
    p="$(cat "$_GRADLE_LOCK_DIR/pid" 2>/dev/null || true)"          # steal if holder is dead…
    if { [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; }; then rm -rf "$_GRADLE_LOCK_DIR" 2>/dev/null; continue; fi
    if [ ! -e "$_GRADLE_LOCK_DIR/pid" ] && [ "$waited" -ge 60 ]; then rm -rf "$_GRADLE_LOCK_DIR" 2>/dev/null; continue; fi  # …or pidless+stale
    [ "$waited" = 0 ] && echo "lock: another gradle run holds this working copy; waiting…" >&2
    sleep 3; waited=$((waited+3))
    [ "$waited" -ge 1800 ] && { echo "lock: timed out (30m) waiting for gradle lock" >&2; _GRADLE_LOCK_DIR=""; return 75; }
  done
  echo "$$" > "$_GRADLE_LOCK_DIR/pid" 2>/dev/null || true
  trap 'gradle_lock_release' EXIT INT TERM
}
