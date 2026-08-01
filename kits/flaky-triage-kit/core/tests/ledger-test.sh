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
# The ARGUMENT ORDER is load-bearing and was documented backwards in kernel.md's I11 row for two
# rounds: the file is the subcommand's first positional and `--final` follows it. Reversed, the flag
# is taken as the file, so the command exits 65 "not a ledger" — a MALFORMED-FILE verdict, not I11's
# own 67 — and a reader following the row would have read a broken invocation as a clean session.
# Pinned here so the row and the tool cannot drift apart again.
expect 65 "--final BEFORE the file is not the accepted spelling" -- "$LEDGER" validate --final "$F"

# --- v1 tolerance
jq -n '{run:{}, clusters:[{id:"old"}], events:[]}' > "$TMP/v1.json"
expect 0 "v1 file passes validate" -- "$LEDGER" validate "$TMP/v1.json"

# --- fix 1: cluster-upsert must not crash when no optional flags are given (bash 3.2 ARGS[@] unbound var)
expect 0  "bare-id upsert succeeds (no flags)" -- "$LEDGER" cluster-upsert "$F" cbare
[ "$(jq -r '.clusters[] | select(.id=="cbare") | .status' "$F")" = "proposed" ] && ok || bad "bare-id upsert created proposed cluster"
expect 0  "tests-only upsert succeeds (no metadata flags)" -- "$LEDGER" cluster-upsert "$F" cbare --tests "com.x.OnlyTest"
[ "$(jq -r '.clusters[] | select(.id=="cbare") | .tests[0].fqcn' "$F")" = "com.x.OnlyTest" ] && ok || bad "tests-only upsert recorded fqcn"

# --- fix 2: metadata-only upsert must not wipe existing .tests
expect 0  "seed cluster with tests" -- "$LEDGER" cluster-upsert "$F" ctests --title seed --tests "com.x.AaTest,com.x.BbTest"
expect 0  "metadata-only upsert (no --tests)" -- "$LEDGER" cluster-upsert "$F" ctests --title "seed v2"
[ "$(jq -r '.clusters[] | select(.id=="ctests") | .tests | length' "$F")" = "2" ] && ok || bad "tests survive metadata-only upsert (count)"
[ "$(jq -r '.clusters[] | select(.id=="ctests") | .tests | map(.fqcn) | sort | join(",")' "$F")" = "com.x.AaTest,com.x.BbTest" ] && ok || bad "tests survive metadata-only upsert (content)"
[ "$(jq -r '.clusters[] | select(.id=="ctests") | .title' "$F")" = "seed v2" ] && ok || bad "metadata still applies on tests-preserving upsert"

# --- fix 3: validate must not swallow jq's own error on a corrupted element
CORRUPT="$TMP/corrupt.json"
jq -n '{run:{},clusters:["not-an-object"],events:[]}' > "$CORRUPT"
expect 65 "validate propagates jq error on corrupted cluster element" -- "$LEDGER" validate "$CORRUPT"

# --- fix 4: whole-string regex enforcement (embedded newline must not bypass line-oriented grep)
expect 65 "newline-embedded id rejected at upsert" -- "$LEDGER" cluster-upsert "$F" $'evil\nok' --title t
expect 0  "seed cluster for --test newline probe" -- "$LEDGER" cluster-upsert "$F" cnl --title t
expect 0  "select cnl" -- "$LEDGER" cluster-state "$F" cnl selected
expect 0  "apply cnl" -- "$LEDGER" cluster-state "$F" cnl applied
expect 65 "newline fqcn via --test rejected" -- "$LEDGER" cluster-state "$F" cnl applied --test $'com.x.Evil\ntest=green'
CORRUPT2="$TMP/corrupt-fqcn.json"
jq -n '{run:{},clusters:[{id:"cbadfqcn",status:"proposed",tests:[{fqcn:"not a fqcn!\nrm -rf /"}]}],events:[]}' > "$CORRUPT2"
expect 65 "validate catches hand-corrupted tests[].fqcn" -- "$LEDGER" validate "$CORRUPT2"
CORRUPT2B="$TMP/corrupt-status.json"
jq -n '{run:{},clusters:[{id:"cbadstatus",status:"proposed",tests:[{fqcn:"com.x.OkTest",status:"bogus"}]}],events:[]}' > "$CORRUPT2B"
expect 65 "validate catches bad tests[].status" -- "$LEDGER" validate "$CORRUPT2B"

# --- fix 5: --tests CSV with embedded newline must be rejected outright (not silently truncated)
expect 65 "--tests CSV with embedded newline rejected" -- "$LEDGER" cluster-upsert "$F" cnl2 --title t --tests $'com.x.FooTest\nrm -rf /'

# --- fix 6: cross-call passes>runs must be validated against the stored counterpart
expect 0  "seed cluster for cross-call passes/runs" -- "$LEDGER" cluster-upsert "$F" cpr --title t
expect 0  "select cpr" -- "$LEDGER" cluster-state "$F" cpr selected
expect 0  "apply cpr with passes=1 runs=3" -- "$LEDGER" cluster-state "$F" cpr applied --passes 1 --runs 3
expect 65 "cross-call passes(10) > stored runs(3) rejected" -- "$LEDGER" cluster-state "$F" cpr applied --passes 10
expect 0  "cross-call passes(2) <= stored runs(3) accepted" -- "$LEDGER" cluster-state "$F" cpr applied --passes 2

# --- fix 7: unbounded --signature / --fix-vs-bug must be capped
expect 65 "signature >200 chars rejected" -- "$LEDGER" cluster-upsert "$F" ccap --title t --signature "$(printf 'x%.0s' {1..201})"
expect 0  "signature at 200 chars accepted" -- "$LEDGER" cluster-upsert "$F" ccap --title t --signature "$(printf 'x%.0s' {1..200})"
expect 65 "fix-vs-bug >40 chars rejected" -- "$LEDGER" cluster-upsert "$F" ccap --title t --fix-vs-bug "$(printf 'x%.0s' {1..41})"
expect 0  "fix-vs-bug at 40 chars accepted" -- "$LEDGER" cluster-upsert "$F" ccap --title t --fix-vs-bug "$(printf 'x%.0s' {1..40})"
CORRUPT3="$TMP/corrupt-caps.json"
jq -n --arg sig "$(printf 'x%.0s' {1..201})" '{run:{},clusters:[{id:"ccapx",status:"proposed",tests:[],signature:$sig}],events:[]}' > "$CORRUPT3"
expect 65 "validate catches oversized signature in schema" -- "$LEDGER" validate "$CORRUPT3"
CORRUPT4="$TMP/corrupt-caps2.json"
jq -n --arg fvb "$(printf 'x%.0s' {1..41})" '{run:{},clusters:[{id:"ccapy",status:"proposed",tests:[],fixVsBug:$fvb}],events:[]}' > "$CORRUPT4"
expect 65 "validate catches oversized fixVsBug in schema" -- "$LEDGER" validate "$CORRUPT4"

# --- fix 8: validate must reject trailing-newline-corrupted id and tests[].fqcn
CORRUPT5="$TMP/corrupt-trailing-newline.json"
jq -n '{run:{},clusters:[{id:"abc\n",status:"proposed",tests:[{fqcn:"com.x.Foo\n"}]}],events:[]}' > "$CORRUPT5"
expect 65 "validate rejects trailing-newline-corrupted id" -- "$LEDGER" validate "$CORRUPT5"
CORRUPT6="$TMP/corrupt-fqcn-newline.json"
jq -n '{run:{},clusters:[{id:"valid-id",status:"proposed",tests:[{fqcn:"com.x.Foo\n"}]}],events:[]}' > "$CORRUPT6"
expect 65 "validate rejects trailing-newline-corrupted fqcn" -- "$LEDGER" validate "$CORRUPT6"
CLEAN7="$TMP/clean-no-newline.json"
jq -n '{run:{},clusters:[{id:"valid-id",status:"proposed",tests:[{fqcn:"com.x.Foo"}]}],events:[]}' > "$CLEAN7"
expect 0 "validate accepts clean id and fqcn without newline" -- "$LEDGER" validate "$CLEAN7"

# --- minor: named missing suite cases
expect 0 "bare-id upsert succeeds (explicit minor case)" -- "$LEDGER" cluster-upsert "$F" cminor1
GF="$TMP/greengreen.json"
"$LEDGER" init "$GF" >/dev/null 2>&1
"$LEDGER" cluster-upsert "$GF" gg --title t >/dev/null 2>&1
"$LEDGER" cluster-state "$GF" gg selected >/dev/null 2>&1
"$LEDGER" cluster-state "$GF" gg applied >/dev/null 2>&1
"$LEDGER" cluster-state "$GF" gg green >/dev/null 2>&1
expect 65 "green→green rejected" -- "$LEDGER" cluster-state "$GF" gg green
DF="$TMP/deferredselected.json"
"$LEDGER" init "$DF" >/dev/null 2>&1
"$LEDGER" cluster-upsert "$DF" ds --title t >/dev/null 2>&1
"$LEDGER" cluster-state "$DF" ds selected >/dev/null 2>&1
"$LEDGER" cluster-state "$DF" ds deferred >/dev/null 2>&1
expect 65 "deferred→selected rejected" -- "$LEDGER" cluster-state "$DF" ds selected
MJ="$TMP/malformed.json"
printf '{not valid json' > "$MJ"
expect 65 "malformed-JSON validate rejected" -- "$LEDGER" validate "$MJ"
expect 65 "missing-file validate rejected" -- "$LEDGER" validate "$TMP/does-not-exist.json"

# --- cluster-vrt
"$LEDGER" cluster-upsert "$F" c-vrt --bucket vrt --title "VRT drift" --tests "com.x.VrtTest#a" >/dev/null 2>&1
expect 0  "valid vrt url set"        -- "$LEDGER" cluster-vrt "$F" c-vrt com.x.VrtTest#a "https://vrt-test.example/compare/123"
[ "$(jq -r '.clusters[]|select(.id=="c-vrt")|.tests[0].vrt' "$F")" = "https://vrt-test.example/compare/123" ] && ok || bad "vrt url recorded"
expect 65 "non-vrt url rejected"     -- "$LEDGER" cluster-vrt "$F" c-vrt com.x.VrtTest#a "https://evil.example/x"
expect 65 "url with space rejected"  -- "$LEDGER" cluster-vrt "$F" c-vrt com.x.VrtTest#a "https://vrt-x.example/a b"
expect 66 "unknown cluster rejected" -- "$LEDGER" cluster-vrt "$F" nope com.x.VrtTest#a "https://vrt-x.example/a"
expect 0  "vrt creates missing test entry" -- "$LEDGER" cluster-vrt "$F" c-vrt com.x.NewTest "https://vrt-x.example/9"
[ "$(jq -r '.clusters[]|select(.id=="c-vrt")|.tests|length' "$F")" = "2" ] && ok || bad "vrt added new test entry"
# validate catches a hand-corrupted vrt url
jq '.clusters[0].tests[0].vrt="http://not-vrt"' "$F" > "$TMP/bad.json"
expect 65 "validate rejects bad tests[].vrt" -- "$LEDGER" validate "$TMP/bad.json"

# --- fix 9: validate must reject trailing-newline-corrupted tests[].vrt
CORRUPT7="$TMP/corrupt-vrt-newline.json"
jq '.clusters[0].tests[0].vrt="https://vrt-x.example/9\n"' "$F" > "$CORRUPT7"
expect 65 "validate rejects trailing-newline-corrupted vrt" -- "$LEDGER" validate "$CORRUPT7"

# --- round4 fix 1 (P7): concurrent event writes must ALL survive (locked read-modify-write).
# Pre-fix this dropped ~55% of writers (last mv wins, unlocked jq>tmp&&mv race).
CF="$TMP/concurrent.json"
"$LEDGER" init "$CF" >/dev/null 2>&1
CN=40
for i in $(seq 1 "$CN"); do "$LEDGER" event "$CF" "ev$i" >/dev/null 2>&1 & done
wait
CGOT="$(jq '.events | length' "$CF")"
[ "$CGOT" = "$CN" ] && ok || bad "concurrent event writes: expected $CN survivors, got $CGOT"
[ -d "$CF.lock.d" ] && bad "lock dir leaked after concurrent writers" || ok

# --- round4 fix 2: validate enforces bucket ∈ six + tier ∈ 1-4 (mirrors the write-path enum checks)
BADBUCKET="$TMP/bad-bucket.json"
jq -n '{run:{},clusters:[{id:"bb1",status:"proposed",tests:[],bucket:"garbage"}],events:[]}' > "$BADBUCKET"
expect 65 "validate rejects garbage bucket" -- "$LEDGER" validate "$BADBUCKET"
OUT="$("$LEDGER" validate "$BADBUCKET" 2>&1 1>/dev/null || true)"
case "$OUT" in *bad-bucket*) ok ;; *) bad "validate reason includes bad-bucket (got: $OUT)" ;; esac

BADTIER="$TMP/bad-tier.json"
jq -n '{run:{},clusters:[{id:"bt1",status:"proposed",tests:[],tier:99}],events:[]}' > "$BADTIER"
expect 65 "validate rejects tier 99 (out of 1-4)" -- "$LEDGER" validate "$BADTIER"
OUT="$("$LEDGER" validate "$BADTIER" 2>&1 1>/dev/null || true)"
case "$OUT" in *bad-tier*) ok ;; *) bad "validate reason includes bad-tier (got: $OUT)" ;; esac

GOODBT="$TMP/good-bucket-tier.json"
jq -n '{run:{},clusters:[{id:"gb1",status:"proposed",tests:[],bucket:"selector",tier:2}],events:[]}' > "$GOODBT"
expect 0 "validate accepts a valid bucket+tier" -- "$LEDGER" validate "$GOODBT"

# --- round4 fix 3: init refuses to clobber a populated ledger without --force
INITF="$TMP/init-guard.json"
"$LEDGER" init "$INITF" >/dev/null 2>&1
"$LEDGER" cluster-upsert "$INITF" populated --title t >/dev/null 2>&1
expect 65 "init refuses to clobber populated ledger" -- "$LEDGER" init "$INITF"
[ "$(jq '.clusters|length' "$INITF")" = "1" ] && ok || bad "init guard left populated ledger untouched"
expect 0 "init --force clobbers populated ledger" -- "$LEDGER" init "$INITF" --force
[ "$(jq '.clusters|length' "$INITF")" = "0" ] && ok || bad "init --force actually cleared clusters"
EMPTYINIT="$TMP/init-empty.json"
"$LEDGER" init "$EMPTYINIT" >/dev/null 2>&1
expect 0 "init on an existing-but-empty ledger succeeds without --force" -- "$LEDGER" init "$EMPTYINIT"

# --- round4 fix 4: a bare trailing flag must die(64) cleanly, not crash on `set -u`
expect 64 "cluster-upsert --title with no value"      -- "$LEDGER" cluster-upsert "$F" cflag1 --title
expect 64 "cluster-upsert --detail with no value"     -- "$LEDGER" cluster-upsert "$F" cflag1 --detail
expect 64 "cluster-upsert --bucket with no value"     -- "$LEDGER" cluster-upsert "$F" cflag1 --bucket
expect 64 "cluster-upsert --tier with no value"       -- "$LEDGER" cluster-upsert "$F" cflag1 --tier
expect 64 "cluster-upsert --signature with no value"  -- "$LEDGER" cluster-upsert "$F" cflag1 --signature
expect 64 "cluster-upsert --fix-vs-bug with no value" -- "$LEDGER" cluster-upsert "$F" cflag1 --fix-vs-bug
expect 64 "cluster-upsert --tests with no value"      -- "$LEDGER" cluster-upsert "$F" cflag1 --tests

"$LEDGER" cluster-upsert "$F" cflagstate --title t >/dev/null 2>&1
"$LEDGER" cluster-state  "$F" cflagstate selected >/dev/null 2>&1
expect 64 "cluster-state --passes with no value" -- "$LEDGER" cluster-state "$F" cflagstate applied --passes
expect 64 "cluster-state --runs with no value"   -- "$LEDGER" cluster-state "$F" cflagstate applied --runs
expect 64 "cluster-state --test with no value"   -- "$LEDGER" cluster-state "$F" cflagstate applied --test

expect 64 "event --phase with no value" -- "$LEDGER" event "$F" someevent --phase
expect 64 "event --who with no value"   -- "$LEDGER" event "$F" someevent --who

# --- round4 fix 5: validate rejects duplicate cluster ids (breaks cluster-state's FROM lookup otherwise)
DUPF="$TMP/dup-ids.json"
jq -n '{run:{},clusters:[{id:"same",status:"proposed",tests:[]},{id:"same",status:"proposed",tests:[]}],events:[]}' > "$DUPF"
expect 65 "validate rejects duplicate cluster ids" -- "$LEDGER" validate "$DUPF"
OUT="$("$LEDGER" validate "$DUPF" 2>&1 1>/dev/null || true)"
case "$OUT" in *dup-id*) ok ;; *) bad "validate reason includes dup-id (got: $OUT)" ;; esac

# --- round4 fix 6: validate emits {id, reason} — spot-check two more reason strings
OVERLONG="$TMP/overlong-title.json"
jq -n --arg t "$(printf 'x%.0s' {1..81})" '{run:{},clusters:[{id:"ot1",status:"proposed",tests:[],title:$t}],events:[]}' > "$OVERLONG"
OUT="$("$LEDGER" validate "$OVERLONG" 2>&1 1>/dev/null || true)"
case "$OUT" in *overlong-title*) ok ;; *) bad "validate reason includes overlong-title (got: $OUT)" ;; esac

PGR="$TMP/passes-gt-runs.json"
jq -n '{run:{},clusters:[{id:"pgr1",status:"proposed",tests:[],passes:5,runs:2}],events:[]}' > "$PGR"
OUT="$("$LEDGER" validate "$PGR" 2>&1 1>/dev/null || true)"
case "$OUT" in *"passes>runs"*) ok ;; *) bad "validate reason includes passes>runs (got: $OUT)" ;; esac

echo "ledger-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
