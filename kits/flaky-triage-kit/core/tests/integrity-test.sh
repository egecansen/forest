#!/bin/bash
# Test suite for core/_integrity.sh. Plain bash asserts, no framework.
# The privileged path (real chown to root) cannot be automated — it needs a password. So the tier
# DECISION is a pure function of (owner uid, recorded tier) and is driven here with synthetic
# inputs, exactly as core/tests/rerun-test.sh drives aggregate() via RERUN_LIB_ONLY.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../_integrity.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }
is()  { [ "$(integrity_tier "$1" "$2")" = "$3" ] && ok || bad "owner=$1 state=$2 -> expected $3, got $(integrity_tier "$1" "$2")"; }

# root-owned, agrees with state
is 0 hardened hardened
# user-owned, agrees with state
is 501 unlocked unlocked
is 501 degraded degraded
# fresh install: nothing recorded, user-owned -> the normal un-hardened tier
is 501 "" degraded
# THE dangerous direction: recorded hardened, no longer root-owned
is 501 hardened mismatch
# stronger than recorded is safe, but the state file is out of date
is 0 degraded stale
is 0 unlocked stale
is 0 "" stale
# any unknown recorded value is treated as unprotected, never as hardened
is 501 banana degraded
is 0 banana stale

# --- the two readers: platform-branched stat and jq-less JSON scraping are the parts most likely
# --- to differ across environments, so they get real filesystem fixtures rather than trust.
# --- Representative uid pair: 0 (root), 501 (typical macOS user; Linux uses 1000+).
RT="$(mktemp -d)"; trap 'rm -rf "$RT"' EXIT
mkdir -p "$RT/core"; printf 'x\n' > "$RT/core/probe"

# integrity_owner_uid
[ -z "$(integrity_owner_uid /nonexistent-path-xyz)" ] && ok || bad "owner_uid on a missing path must print nothing"
integrity_owner_uid /nonexistent-path-xyz >/dev/null; [ $? -eq 0 ] && ok || bad "owner_uid on a missing path must return 0"
[ -z "$(integrity_owner_uid)" ] && ok || bad "owner_uid with no argument must print nothing, not error"
[ "$(integrity_owner_uid "$RT/core/probe")" = "$(id -u)" ] && ok || bad "owner_uid must report the real owner of an existing file"
# THE wedge case: stat unavailable must not abort a `set -e` caller (this is why return 0 is explicit)
( set -euo pipefail; . "$HERE/../_integrity.sh"; PATH=/nonexistent-bin integrity_owner_uid /tmp >/dev/null ) 2>/dev/null \
  && ok || bad "owner_uid must not abort a set -e caller when stat is unavailable"

# integrity_state
[ -z "$(integrity_state "$RT")" ] && ok || bad "state with no .lock-state must print nothing"
integrity_state "$RT" >/dev/null; [ $? -eq 0 ] && ok || bad "state with no .lock-state must return 0"
[ -z "$(integrity_state)" ] && ok || bad "state with no argument must print nothing, not error"
printf '{"tier":"hardened","at":"2026-07-29T00:00:00Z"}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = hardened ] && ok || bad "state must read the tier the writer emits"
printf '{"at":"x","note":"no tier here"}\n' > "$RT/core/.lock-state"
[ -z "$(integrity_state "$RT")" ] && ok || bad "state must print nothing when no tier key is present"
# Ambiguity: two tier keys must resolve the SAME way regardless of line wrapping — first wins.
printf '{"history":[{"tier":"unlocked"},{"tier":"hardened"}]}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = unlocked ] && ok || bad "two tier keys on ONE line must resolve first-wins"
printf '{"history":[{"tier":"unlocked"},\n{"tier":"hardened"}]}\n' > "$RT/core/.lock-state"
[ "$(integrity_state "$RT")" = unlocked ] && ok || bad "two tier keys across TWO lines must resolve first-wins, same as one line"

# --- integrity_guard: behaviour per state ---
GTMP="$(mktemp -d)"; mkdir -p "$GTMP/core"
guard_out() { printf '%s' "$1" > "$GTMP/core/.lock-state"; INTEGRITY_FAKE_UID="$2" integrity_guard "$GTMP" 2>&1; }
guard_rc()  { printf '%s' "$1" > "$GTMP/core/.lock-state"; INTEGRITY_FAKE_UID="$2" integrity_guard "$GTMP" >/dev/null 2>&1; echo $?; }

[ -z "$(guard_out '{"tier":"hardened"}' 0)" ] && ok || bad "hardened must be silent"
[ "$(guard_rc '{"tier":"hardened"}' 0)" = 0 ] && ok || bad "hardened must return 0"
case "$(guard_out '{"tier":"unlocked"}' 501)" in *"maintenance"*) ok ;; *) bad "unlocked must remind the user to re-lock" ;; esac
[ "$(guard_rc '{"tier":"unlocked"}' 501)" = 0 ] && ok || bad "unlocked must not block the run"
case "$(guard_out '{"tier":"degraded"}' 501)" in *DEGRADED*) ok ;; *) bad "degraded must emit a one-line notice" ;; esac
[ "$(guard_rc '{"tier":"degraded"}' 501)" = 0 ] && ok || bad "degraded must not block the run"
case "$(guard_out '{"tier":"hardened"}' 501)" in *MISMATCH*) ok ;; *) bad "mismatch must be loud" ;; esac
[ "$(guard_rc '{"tier":"hardened"}' 501)" = 76 ] && ok || bad "mismatch must return 76 so callers refuse"
rm -rf "$GTMP"

echo "integrity-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
