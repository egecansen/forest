#!/bin/bash
# core/tests/rerun-test.sh — first test suite for core/rerun.sh's aggregation (per-test green-proof
# completeness, I11/kernel §5.3). Plain bash asserts, no framework (mirrors ledger-test.sh's style).
#
# Uses the RERUN_LIB_ONLY=1 test seam (see rerun.sh header) to source parse_outcomes/aggregate/
# build_result without invoking gradle/Selenoid, then drives them with synthetic per-pass logs.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RERUN="$HERE/../rerun.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

# Load the pure functions into THIS shell (no CLI body runs — see rerun.sh's RERUN_LIB_ONLY guard).
RERUN_LIB_ONLY=1 . "$RERUN"

jf() { jq -r "$1"; }   # $1=filter, reads stdin JSON

# --- scenario 1 (the audit repro): 3 passes requested; testX reports in only 1 of 3 (JVM
#     crash/hang/timeout in the other passes — simulated by simply not appearing in r2/r3);
#     testY reports (and passes) in all 3.
printf 'TestX > testA() PASSED\nTestY > testB() PASSED\n' > "$TMP/r1.log"
printf 'TestY > testB() PASSED\n'                          > "$TMP/r2.log"
printf 'TestY > testB() PASSED\n'                          > "$TMP/r3.log"
cat "$TMP"/r1.log "$TMP"/r2.log "$TMP"/r3.log > "$TMP/combined1.txt"
RES1="$(build_result "$TMP/combined1.txt" 3)"

[ "$(echo "$RES1" | jf '.["TestX.testA"].runs')" = "1" ] && ok || bad "testX runs=1 (reported in only 1 of 3 passes)"
[ "$(echo "$RES1" | jf '.["TestX.testA"].insufficient')" = "true" ] && ok || bad "testX flagged insufficient:true"
[ "$(echo "$RES1" | jf '.["TestX.testA"].confidence')" = "null" ] && ok || bad "testX confidence is NOT 1.0 (must read null, not a false green)"
[ "$(echo "$RES1" | jf '.["TestY.testB"].runs')" = "3" ] && ok || bad "testY runs=3 (reported in every pass)"
[ "$(echo "$RES1" | jf '.["TestY.testB"].confidence')" = "1" ] && ok || bad "testY confidence=1.0 (genuinely green-proofed)"
[ "$(echo "$RES1" | jf '.["TestY.testB"] | has("insufficient")')" = "false" ] && ok || bad "testY not flagged (no insufficient key — preserves existing schema for complete tests)"

# --- scenario 2: an undersampled test whose partial signal was ALREADY not a false green
#     (1 pass + 1 fail out of 3 requested) — insufficient:true, but its real confidence (0.5)
#     must be preserved, not blanket-nulled. Guards against an overzealous "null everything
#     insufficient" implementation.
printf 'TestZ > testC() PASSED\n' > "$TMP/r1b.log"
printf 'TestZ > testC() FAILED\n' > "$TMP/r2b.log"
printf ''                          > "$TMP/r3b.log"
cat "$TMP"/r1b.log "$TMP"/r2b.log "$TMP"/r3b.log > "$TMP/combined2.txt"
RES2="$(build_result "$TMP/combined2.txt" 3)"
[ "$(echo "$RES2" | jf '.["TestZ.testC"].runs')" = "2" ] && ok || bad "testZ runs=2 of 3 requested"
[ "$(echo "$RES2" | jf '.["TestZ.testC"].insufficient')" = "true" ] && ok || bad "testZ flagged insufficient (runs<requested)"
[ "$(echo "$RES2" | jf '.["TestZ.testC"].confidence')" = "0.5" ] && ok || bad "testZ real confidence (0.5) preserved, not nulled (wasn't a false-1.0 case)"

# --- scenario 3: a fail-only undersampled test (pass=0). confidence is already 0 (never a
#     false-green risk) — must stay 0, not be nulled, even though insufficient:true.
printf 'TestW > testD() FAILED\n' > "$TMP/r1c.log"
printf ''                          > "$TMP/r2c.log"
printf ''                          > "$TMP/r3c.log"
cat "$TMP"/r1c.log "$TMP"/r2c.log "$TMP"/r3c.log > "$TMP/combined3.txt"
RES3="$(build_result "$TMP/combined3.txt" 3)"
[ "$(echo "$RES3" | jf '.["TestW.testD"].insufficient')" = "true" ] && ok || bad "testW (fail-only, undersampled) flagged insufficient"
[ "$(echo "$RES3" | jf '.["TestW.testD"].confidence')" = "0" ] && ok || bad "testW confidence stays 0 (already non-misleading; not nulled)"

# --- scenario 4: a test that completed the full requested N with a mixed (proven-flaky)
#     outcome must NOT be flagged insufficient, and its fractional confidence is untouched.
printf 'TestV > testE() PASSED\n' > "$TMP/r1d.log"
printf 'TestV > testE() FAILED\n' > "$TMP/r2d.log"
printf 'TestV > testE() PASSED\n' > "$TMP/r3d.log"
cat "$TMP"/r1d.log "$TMP"/r2d.log "$TMP"/r3d.log > "$TMP/combined4.txt"
RES4="$(build_result "$TMP/combined4.txt" 3)"
[ "$(echo "$RES4" | jf '.["TestV.testE"].runs')" = "3" ] && ok || bad "testV ran all 3 requested passes"
[ "$(echo "$RES4" | jf '.["TestV.testE"] | has("insufficient")')" = "false" ] && ok || bad "testV (full N, proven-flaky) not flagged insufficient"
[ "$(echo "$RES4" | jf '.["TestV.testE"].confidence')" = "0.6666666666666666" ] && ok || bad "testV confidence unaffected by the fix (2/3)"

# --- scenario 5: top-level insufficient_runs derivation (the exact jq snippet rerun.sh's CLI
#     body uses to build the top-level array from build_result's tests map) — combine scenarios
#     1-4's tests map and assert only the truly-undersampled fqcns are listed.
COMBINED_TESTS="$(jq -n --argjson a "$RES1" --argjson b "$RES2" --argjson c "$RES3" --argjson d "$RES4" '$a+$b+$c+$d')"
IR="$(echo "$COMBINED_TESTS" | jq -c '[to_entries[]|select(.value.insufficient==true)|.key]')"
[ "$(echo "$IR" | jq 'sort')" = "$(printf '["TestW.testD","TestX.testA","TestZ.testC"]' | jq 'sort')" ] \
  && ok || bad "insufficient_runs lists exactly the undersampled fqcns: got $IR"
[ "$(echo "$IR" | jq 'index("TestY.testB")')" = "null" ] && ok || bad "insufficient_runs excludes the fully-green testY"
[ "$(echo "$IR" | jq 'index("TestV.testE")')" = "null" ] && ok || bad "insufficient_runs excludes the fully-run proven-flaky testV"

# --- scenario 6: RERUN_FROM_LOG's fixed runs_requested=1 call shape must be unaffected (a
#     test reporting once against N=1 is COMPLETE, not insufficient) — no regression for that mode.
printf 'TestU > testF() PASSED\n' > "$TMP/single.log"
RES6="$(build_result "$TMP/single.log" 1)"
[ "$(echo "$RES6" | jf '.["TestU.testF"] | has("insufficient")')" = "false" ] && ok || bad "single-log (N=1) mode: a test reporting once is NOT insufficient"
[ "$(echo "$RES6" | jf '.["TestU.testF"].confidence')" = "1" ] && ok || bad "single-log (N=1) mode: genuinely green result preserved"

echo "rerun-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
