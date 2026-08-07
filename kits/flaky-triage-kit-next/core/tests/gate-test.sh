#!/bin/bash
# Test suite for core/gate.sh (hektor.flaky.verifier.v1). Plain bash asserts, no framework.
# Feeds synthetic rerun.sh-shaped JSON (the documented contract in core/rerun.sh:9-20) through the
# gate and asserts the per-test decision, the precedence between branches, and the roll-up.
# No gradle/Selenoid: the gate is a pure function of rerun.sh's output.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$HERE/../gate.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

# decision <json> <test-id> -> prints that candidate's decision
decision() { printf '%s' "$1" | "$GATE" | jq -r --arg t "$2" '.candidates[]|select(.candidate_id==$t)|.decision'; }
# field <json> <jq-path>
field()    { printf '%s' "$1" | "$GATE" | jq -c "$2"; }

# A run with one test per decision branch. N=3.
BASE='{"tb":161,"runs":3,"runs_requested":3,"early_exit":false,
 "broken_box_suspected":false,"run_anomalous":false,
 "box_health":{"pass":90,"fail":10,"rate":0.9},"insufficient_runs":["C.tUnder"],
 "tests":{
  "C.tGreen": {"pass":3,"fail":0,"skip":0,"runs":3,"confidence":1.0},
  "C.tFlaky": {"pass":2,"fail":1,"skip":0,"runs":3,"confidence":0.66},
  "C.tRed":   {"pass":0,"fail":3,"skip":0,"runs":3,"confidence":0},
  "C.tUnder": {"pass":2,"fail":0,"skip":0,"runs":2,"confidence":null,"insufficient":true},
  "C.tSkip":  {"pass":0,"fail":0,"skip":3,"runs":3,"confidence":null}
 }}'

# --- the five per-test branches -------------------------------------------------
[ "$(decision "$BASE" C.tGreen)" = accepted ]     && ok || bad "pass^N over N runs must be accepted"
[ "$(decision "$BASE" C.tFlaky)" = rejected ]     && ok || bad "fail>0 with pass>0 (still flaky) must be rejected"
[ "$(decision "$BASE" C.tRed)"   = rejected ]     && ok || bad "all-fail must be rejected"
[ "$(decision "$BASE" C.tUnder)" = inconclusive ] && ok || bad "insufficient:true must be inconclusive, never accepted"
[ "$(decision "$BASE" C.tSkip)"  = inconclusive ] && ok || bad "skip-only (no PASS/FAIL) must be inconclusive"

# The insufficient reason must speak rerun.sh's vocabulary, not the generic under-proven one.
case "$(printf '%s' "$BASE" | "$GATE" | jq -r '.candidates[]|select(.candidate_id=="C.tUnder")|.reasons[0]')" in
  *insufficient*) ok ;; *) bad "insufficient branch must name the rerun.sh flag in its reason" ;;
esac

# --- a green run that is simply under-proven (no insufficient flag set) ----------
UNDER="$(printf '%s' "$BASE" | jq '.tests={"C.u":{"pass":2,"fail":0,"skip":0,"runs":2,"confidence":1.0}}')"
[ "$(decision "$UNDER" C.u)" = inconclusive ] && ok || bad "runs<N must never be accepted even at confidence 1.0"

# --- I9: an untrustworthy oracle decides NOTHING, however green -----------------
for flagname in broken_box_suspected run_anomalous; do
  BROKE="$(printf '%s' "$BASE" | jq --arg f "$flagname" '.[$f]=true')"
  [ "$(decision "$BROKE" C.tGreen)" = inconclusive ] \
    && ok || bad "$flagname must force inconclusive even for a perfect pass^N"
  [ "$(field "$BROKE" '.summary.accepted')" = 0 ] \
    && ok || bad "$flagname must yield zero accepted"
  [ "$(field "$BROKE" '.untrustworthy')" = true ] \
    && ok || bad "$flagname must surface untrustworthy:true"
done

# --- precedence: a DECIDED failure outranks the insufficient flag ---------------
CONFLICT="$(printf '%s' "$BASE" | jq '.tests={"C.c":{"pass":1,"fail":1,"skip":0,"runs":2,"confidence":0.5,"insufficient":true}}')"
[ "$(decision "$CONFLICT" C.c)" = rejected ] && ok || bad "fail>0 must outrank insufficient (a failure is decided, not undersampled)"

# --- roll-up --------------------------------------------------------------------
[ "$(field "$BASE" '.summary')" = '{"accepted":1,"rejected":2,"inconclusive":2}' ] \
  && ok || bad "summary counts must match the five branches"
[ "$(field "$BASE" '.all_accepted')" = false ] && ok || bad "all_accepted must be false when anything is not accepted"

ALLGREEN="$(printf '%s' "$BASE" | jq '.tests={"C.a":{"pass":3,"fail":0,"skip":0,"runs":3,"confidence":1.0},"C.b":{"pass":3,"fail":0,"skip":0,"runs":3,"confidence":1.0}}')"
[ "$(field "$ALLGREEN" '.all_accepted')" = true ] && ok || bad "all_accepted must be true when every candidate is accepted"

EMPTY="$(printf '%s' "$BASE" | jq '.tests={}')"
[ "$(field "$EMPTY" '.all_accepted')" = false ] \
  && ok || bad "all_accepted must be false on an EMPTY candidate set (accepted>0 is required — vacuous truth is a false green)"

# --- artifact shape -------------------------------------------------------------
[ "$(field "$BASE" '.read_only')"     = true ] && ok || bad "gate must declare read_only:true (it never mutates)"
[ "$(field "$BASE" '.schema_version')" = '"hektor.flaky.verifier.v1"' ] && ok || bad "schema_version must be pinned"
[ "$(field "$BASE" '.insufficient_runs')" = '["C.tUnder"]' ] && ok || bad "insufficient_runs must be carried through from rerun.sh"
[ "$(GATE_BUILD=2026-07-29T10:00:00Z field "$BASE" '.build')" = '"2026-07-29T10:00:00Z"' ] \
  && ok || bad "GATE_BUILD must be recorded for traceability"
[ "$(field "$BASE" '.build')" = null ] && ok || bad "build must be null (not empty string) when GATE_BUILD is unset"

# --- N fallback when runs_requested is absent -----------------------------------
NON="$(printf '%s' "$BASE" | jq 'del(.runs_requested)')"
[ "$(field "$NON" '.runs_requested')" = 3 ] && ok || bad "runs_requested must fall back to .runs"

# --- input validation -----------------------------------------------------------
printf '{"nope":1}' | "$GATE" >/dev/null 2>&1; [ "$?" -eq 64 ] && ok || bad "non-rerun.sh JSON must exit 64"
printf 'not json'   | "$GATE" >/dev/null 2>&1; [ "$?" -eq 64 ] && ok || bad "malformed input must exit 64"

echo "gate-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
