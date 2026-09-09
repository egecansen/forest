#!/bin/bash
# box-lease.sh — mutual exclusion over a pool of reserved testboxes.
#
# Why: in a multi-ticket fan-out, AUTHORING is parallel (each ticket owns its own
# worktree, no shared state) but RUNNING is not — two `gradle test` runs on the
# same testbox share a browser grid, a login session and mutable classified data,
# so their results are noise. This script lets N parallel workers share M boxes:
# each acquires a box before `gradle test` and releases it after, so at most M
# runs are ever in flight and no box hosts two at once.
#
# The lease lives OUTSIDE every worktree (worktrees don't share docs/hektor/), so
# workers in different worktrees — and different Claude sessions — see one pool.
# Acquire is an atomic `mkdir`: the kernel picks exactly one winner per box, no
# read-then-write race.
#
# Usage:
#   box-lease.sh acquire --pool "x:161,x:230" --holder WEBT-254523 [--timeout 3600] [--stale 2700]
#     -> stdout, eval-able:  HEKTOR_BOX_DC=x
#                            HEKTOR_BOX_ID=161
#                            HEKTOR_GRADLE_ARGS='-Denv.launchpad=selenoid -Denv.data.center=x -Dui.testbox=161'
#                            HEKTOR_BOX_URL=http://xtbx161
#     -> exit 75 if no box came free within --timeout
#   box-lease.sh release --holder WEBT-254523            # releases every box that holder owns
#   box-lease.sh release --box x:161 --holder WEBT-254523 # one box, holder must match
#   box-lease.sh renew   --holder WEBT-254523            # for a run outliving --stale
#   box-lease.sh status  [--pool "x:161,x:230"]          # who holds what, and for how long
#
# Options:
#   --pool <list>    comma-separated dc:id pairs, e.g. "x:161,x:230,y:52"
#   --holder <id>    lease owner label — use the ticket key
#   --timeout <s>    how long acquire waits for a free box (default 3600)
#   --stale <s>      a lease this old whose holder process is GONE is stolen
#                    (default 2700 = 45min). Age alone never steals — see acquire.
#   --hard-stale <s> age past which a lease is stolen even if the holder looks
#                    alive, for a wedged process (default 4x --stale)
#   --pid <n>        liveness handle recorded with the lease (default: the calling
#                    shell, $PPID). Pass --pid $$ from a wrapper that outlives it.
#   --force          release a box whose holder does not match (manual unwedge)
#   --root <dir>     lease root (default ~/.forest/hektor-box-leases)
#
# Exit codes: 0 ok · 64 usage · 75 timed out waiting for a box
#             77 refused: that box belongs to another holder
set -uo pipefail

ACTION="${1:-}"; shift || true
POOL=""; HOLDER=""; BOX=""; TIMEOUT=3600; STALE=2700; HARD_STALE=""; FORCE=0
PID="${PPID:-$$}"
ROOT="${HEKTOR_BOX_LEASE_ROOT:-$HOME/.forest/hektor-box-leases}"

die() { echo "box-lease: $1" >&2; exit "${2:-64}"; }
need_int() {             # $1=value $2=flag name — a non-numeric would blow up the
  case "$1" in ''|*[!0-9]*) die "$2 must be a whole number of seconds, got '$1'" ;; esac
}                        # arithmetic below with a confusing shell error

while [ $# -gt 0 ]; do
  case "$1" in
    --pool)    POOL="${2:-}"; shift 2 ;;
    --holder)  HOLDER="${2:-}"; shift 2 ;;
    --box)     BOX="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-3600}"; shift 2 ;;
    --stale)   STALE="${2:-2700}"; shift 2 ;;
    --hard-stale) HARD_STALE="${2:-}"; shift 2 ;;
    --pid)     PID="${2:-}"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    --root)    ROOT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,44p' "$0"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done
need_int "$TIMEOUT" --timeout
need_int "$STALE" --stale
need_int "$PID" --pid
# The hard ceiling is what steals a lease whose holder still looks ALIVE, so it
# must not be derivable down to nothing: `--stale 0` would otherwise set it to 0
# and hand a running worker's box to the next caller — the exact double-run this
# script prevents. Floor the derived value at an hour; an explicit --hard-stale
# is honoured as given (that's the deliberate override).
if [ -z "$HARD_STALE" ]; then
  HARD_STALE=$(( STALE * 4 ))
  [ "$HARD_STALE" -ge 3600 ] || HARD_STALE=3600
fi
need_int "$HARD_STALE" --hard-stale
# The holder label is written to a file and echoed by `status`; keep it to
# characters that cannot forge a second line or escape a path.
if [ -n "$HOLDER" ]; then
  case "$HOLDER" in *[!A-Za-z0-9._-]*) die "bad --holder '$HOLDER' — use the ticket key (A-Z a-z 0-9 . _ -)" ;; esac
fi
mkdir -p "$ROOT" || die "cannot create lease root $ROOT" 64

now() { date +%s; }
# mtime in epoch seconds — BSD (macOS) first, then GNU.
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

# A dc/id pair reaches the caller through `eval "$(box-lease.sh acquire …)"`, so
# it MUST be validated here, not merely parsed: any character that survives into
# the emitted single-quoted string is a command-injection sink — one apostrophe
# in a pool entry closes the quoting and the remainder executes. Verified
# exploitable before this guard existed. One lowercase letter for the data
# centre, digits for the id, nothing else, ever.
validate_box() {         # $1=dc $2=id
  case "$1" in [a-z]) ;; *) die "bad data centre '$1' — expected one lowercase letter (x|y)" ;; esac
  case "$2" in ''|*[!0-9]*) die "bad box id '$2' — digits only" ;; esac
  [ "${#2}" -le 6 ] || die "bad box id '$2' — too long"
}

parse_pool() {           # echoes one validated "dc id" pair per line
  [ -n "$POOL" ] || die "--pool is required (e.g. --pool \"x:161,x:230\")"
  # The trailing newline matters: `while read` skips a final unterminated line,
  # which would silently hide the LAST box in the pool from every caller.
  printf '%s\n' "$POOL" | tr ',' '\n' | while IFS= read -r p; do
    p="$(printf '%s' "$p" | tr -d '[:space:]')"; [ -n "$p" ] || continue
    case "$p" in
      *:*)           dc="${p%%:*}"; id="${p##*:}" ;;
      # bare "tbx161" / "x161" / "161" — assume dc x when only an id is given
      tb[a-z][0-9]*) dc="${p:2:1}"; id="${p:3}" ;;
      [a-z][0-9]*)   dc="${p:0:1}"; id="${p:1}" ;;
      [0-9]*)        dc="x";        id="$p" ;;
      *) die "cannot parse box '$p' — use dc:id, e.g. x:161" ;;
    esac
    validate_box "$dc" "$id"
    echo "$dc $id"
  done
}

# parse_pool's body is a pipeline, so its `die` only kills a SUBSHELL — a caller
# that streamed it with `while read … < <(parse_pool)` saw "no boxes" instead of
# an error and, in acquire, spun forever re-reporting it. Resolve the pool ONCE,
# up front, and let a bad pool fail the whole script here.
POOL_PAIRS=""
load_pool() {
  POOL_PAIRS="$(parse_pool)" || exit $?
  [ -n "$POOL_PAIRS" ] || die "pool '$POOL' resolved to no usable box"
}

emit() {                 # $1=dc $2=id
  echo "HEKTOR_BOX_DC=$1"
  echo "HEKTOR_BOX_ID=$2"
  echo "HEKTOR_GRADLE_ARGS='-Denv.launchpad=selenoid -Denv.data.center=$1 -Dui.testbox=$2'"
  echo "HEKTOR_BOX_URL=http://$1tb$1$2"
}

case "$ACTION" in
  acquire)
    [ -n "$HOLDER" ] || die "--holder is required (use the ticket key)"
    load_pool
    deadline=$(( $(now) + TIMEOUT ))
    announced=0
    while :; do
      while read -r dc id; do
        [ -n "$dc" ] || continue
        lease="$ROOT/$dc$id.lease"
        # Reap an abandoned lease — a worker that died mid-run must not park its
        # box forever. But age ALONE is the wrong test: mtime is stamped at
        # acquire and never refreshed, so a legitimately long suite run would get
        # its box stolen while still driving a browser on it — precisely the
        # collision this lease exists to prevent. So steal only when the holder
        # is demonstrably gone (recorded pid no longer alive), or when the lease
        # is so old that a hung holder is worse than a possible double-run.
        if [ -d "$lease" ]; then
          age=$(( $(now) - $(mtime "$lease") ))
          prev="$(cat "$lease/holder" 2>/dev/null || echo unknown)"
          hpid="$(cat "$lease/pid" 2>/dev/null || echo '')"
          dead=0
          if [ -n "$hpid" ] && [ "$hpid" -eq "$hpid" ] 2>/dev/null; then
            kill -0 "$hpid" 2>/dev/null || dead=1
          else
            dead=1                               # no pid recorded — age is all we have
          fi
          reason=""
          [ "$age" -gt "$STALE" ] && [ "$dead" -eq 1 ] && reason="holder gone, ${age}s old"
          [ "$age" -gt "$HARD_STALE" ] && reason="${age}s old — past the ${HARD_STALE}s hard ceiling"
          if [ -n "$reason" ]; then
            echo "box-lease: stealing lease on $dc$id from '$prev' ($reason)" >&2
            rm -f "$lease/holder" "$lease/since" "$lease/pid" 2>/dev/null
            rmdir "$lease" 2>/dev/null
          fi
        fi
        if mkdir "$lease" 2>/dev/null; then      # atomic — exactly one winner
          printf '%s\n' "$HOLDER" > "$lease/holder"
          printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lease/since"
          printf '%s\n' "$PID" > "$lease/pid"
          emit "$dc" "$id"
          exit 0
        fi
      done <<< "$POOL_PAIRS"
      remaining=$(( deadline - $(now) ))
      [ "$remaining" -gt 0 ] || die "no box free in pool '$POOL' after ${TIMEOUT}s" 75
      if [ "$announced" -eq 0 ]; then
        echo "box-lease: all boxes busy — $HOLDER waiting (pool: $POOL)" >&2
        announced=1
      fi
      sleep $(( remaining < 20 ? remaining : 20 ))
    done
    ;;

  release)
    released=0
    drop() {                                     # $1=lease dir
      rm -f "$1/holder" "$1/since" "$1/pid"
      rmdir "$1" 2>/dev/null && released=$((released+1))
    }
    if [ -n "$BOX" ]; then
      # Releasing BY BOX used to free the lease whoever held it — one worker
      # could hand another worker's in-flight box to a third, putting two runs
      # on it. Now a mismatched holder is refused unless --force says so
      # explicitly (the manual "unwedge a dead worker's box" path).
      POOL="$BOX"; load_pool
      while read -r dc id; do
        lease="$ROOT/$dc$id.lease"
        [ -d "$lease" ] || continue
        owner="$(cat "$lease/holder" 2>/dev/null || echo unknown)"
        if [ -n "$HOLDER" ] && [ "$owner" != "$HOLDER" ]; then
          die "$dc$id is held by '$owner', not '$HOLDER' — refusing (pass --force to override)" 77
        fi
        if [ -z "$HOLDER" ] && [ "$FORCE" -eq 0 ]; then
          die "$dc$id is held by '$owner' — release needs a matching --holder, or --force" 77
        fi
        drop "$lease"
      done <<< "$POOL_PAIRS"
    else
      [ -n "$HOLDER" ] || die "release needs --holder or --box"
      for lease in "$ROOT"/*.lease; do
        [ -d "$lease" ] || continue
        [ "$(cat "$lease/holder" 2>/dev/null)" = "$HOLDER" ] || continue
        drop "$lease"
      done
    fi
    echo "box-lease: released $released lease(s)"
    ;;

  renew)
    # For a run that legitimately outlives --stale: refresh the lease so the
    # liveness check has a current timestamp to work with.
    [ -n "$HOLDER" ] || die "renew needs --holder"
    renewed=0
    for lease in "$ROOT"/*.lease; do
      [ -d "$lease" ] || continue
      [ "$(cat "$lease/holder" 2>/dev/null)" = "$HOLDER" ] || continue
      touch "$lease"; printf '%s\n' "$PID" > "$lease/pid"; renewed=$((renewed+1))
    done
    echo "box-lease: renewed $renewed lease(s) for $HOLDER"
    ;;

  status)
    # Validate the pool BEFORE reporting: printing "no leases held" and only then
    # rejecting a malformed pool reads as "nothing wrong here".
    [ -n "$POOL" ] && load_pool
    found=0
    for lease in "$ROOT"/*.lease; do
      [ -d "$lease" ] || continue
      found=1
      printf '%-10s held by %-16s since %s (%ss)\n' \
        "$(basename "$lease" .lease)" \
        "$(cat "$lease/holder" 2>/dev/null || echo '?')" \
        "$(cat "$lease/since" 2>/dev/null || echo '?')" \
        "$(( $(now) - $(mtime "$lease") ))"
    done
    [ "$found" -eq 1 ] || echo "box-lease: no leases held"
    if [ -n "$POOL" ]; then
      while read -r dc id; do
        [ -d "$ROOT/$dc$id.lease" ] || echo "$dc$id       free"
      done <<< "$POOL_PAIRS"
    fi
    ;;

  *) die "usage: box-lease.sh acquire|release|status [options] (see --help)" ;;
esac
