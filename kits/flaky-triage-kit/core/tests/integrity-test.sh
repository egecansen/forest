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

echo "integrity-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
