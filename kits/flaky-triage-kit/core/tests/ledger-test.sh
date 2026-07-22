#!/bin/bash
# First test suite for core/ledger.sh (v2 contract). Plain bash asserts, no framework.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER="$HERE/../ledger.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
F="$TMP/ledger.json"
pass=0; fail=0
ok()   { pass=$((pass+1)); }
bad()  { fail=$((fail+1)); echo "FAIL: $1" >&2; }
# expect <expected-exit> <desc> -- cmd...
expect() { local want="$1" desc="$2"; shift 3
  "$@" >/dev/null 2>&1; local got=$?
  [ "$got" -eq "$want" ] && ok || bad "$desc (want exit $want, got $got)"; }

# --- init stamps version 2
"$LEDGER" init "$F" 2>/dev/null
[ "$(jq -r '.run.version' "$F")" = "2" ] && ok || bad "init stamps run.version=2"

# --- upsert: create + validation
expect 0  "valid upsert creates proposed" -- "$LEDGER" cluster-upsert "$F" c1-selectors \
  --title "Relocated selectors" --detail "blog anchor moved" --bucket selector \
  --tests "com.x.FooTest#a,com.x.BarTest"
[ "$(jq -r '.clusters[0].status' "$F")" = "proposed" ] && ok || bad "created status proposed"
[ "$(jq -r '.clusters[0].tests[0].fqcn' "$F")" = "com.x.FooTest#a" ] && ok || bad "tests are {fqcn} objects"
expect 65 "bad bucket rejected"      -- "$LEDGER" cluster-upsert "$F" c2 --bucket banana
expect 65 "bad id rejected"          -- "$LEDGER" cluster-upsert "$F" "C2 UPPER" --bucket vrt
expect 65 "overlong title rejected"  -- "$LEDGER" cluster-upsert "$F" c2 --bucket vrt --title "$(printf 'x%.0s' {1..81})"
expect 65 "bad fqcn rejected"        -- "$LEDGER" cluster-upsert "$F" c2 --bucket vrt --tests 'rm -rf /'
expect 0  "upsert merges (idempotent)" -- "$LEDGER" cluster-upsert "$F" c1-selectors --title "Relocated selectors v2"
[ "$(jq '.clusters | length' "$F")" = "1" ] && ok || bad "merge did not duplicate"

# --- state transitions
expect 0  "proposed→selected"        -- "$LEDGER" cluster-state "$F" c1-selectors selected
expect 0  "selected→applied+counts"  -- "$LEDGER" cluster-state "$F" c1-selectors applied --passes 1 --runs 3
expect 65 "passes>runs rejected"     -- "$LEDGER" cluster-state "$F" c1-selectors applied --passes 4 --runs 3
expect 0  "applied→applied count update" -- "$LEDGER" cluster-state "$F" c1-selectors applied --passes 2 --runs 3
expect 0  "per-test divergence"      -- "$LEDGER" cluster-state "$F" c1-selectors applied --test "com.x.FooTest#a=green"
[ "$(jq -r '.clusters[0].tests[0].status' "$F")" = "green" ] && ok || bad "divergence recorded"
expect 65 "applied→proposed rejected"    -- "$LEDGER" cluster-state "$F" c1-selectors proposed
expect 66 "unknown id rejected"          -- "$LEDGER" cluster-state "$F" nope green
expect 0  "applied→green"                -- "$LEDGER" cluster-state "$F" c1-selectors green
expect 65 "terminal→selected rejected"   -- "$LEDGER" cluster-state "$F" c1-selectors selected

# --- events
expect 0  "phase event"  -- "$LEDGER" event "$F" phase-enter --phase verify
expect 65 "bad phase"    -- "$LEDGER" event "$F" phase-enter --phase warp
[ "$(jq -r '.events[-1].phase' "$F")" = "verify" ] && ok || bad "event phase recorded"

# --- validate
expect 0  "validate clean"           -- "$LEDGER" validate "$F"
expect 0  "validate --final clean"   -- "$LEDGER" validate "$F" --final
"$LEDGER" cluster-upsert "$F" c9 --bucket infra --title t >/dev/null 2>&1
"$LEDGER" cluster-state  "$F" c9 selected >/dev/null 2>&1
expect 67 "--final fails on selected"  -- "$LEDGER" validate "$F" --final
expect 0  "plain validate still clean" -- "$LEDGER" validate "$F"

# --- v1 tolerance
jq -n '{run:{}, clusters:[{id:"old"}], events:[]}' > "$TMP/v1.json"
expect 0 "v1 file passes validate" -- "$LEDGER" validate "$TMP/v1.json"

echo "ledger-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
