#!/bin/bash
# core/rerun.sh — re-run a FQCN list on a testbox via Selenoid; the verification oracle.
#
# Enforces: I1 (validate) · I2 (gradle -Dtests) · I9 (broken-box heuristic + box-health cross-check;
#           distinguishes "ran and failed" from "didn't run") · V2 (N-run confidence) ·
#           I11/kernel §5.3 (confirm at pass^N, not pass^1 — PER-TEST completeness, not just
#           pass-level: a test whose JVM crashed/hung/timed out in every pass but one must not
#           read confidence:1.0 off that single lucky pass)
# Contract: $1=fqcn-csv $2=tb →
#   {tb,runs,runs_requested,early_exit,runs_with_tests,incomplete_runs,box_health,broken_box_suspected,
#    run_anomalous,logdir,insufficient_runs:[<fqcn>...],
#    tests:{<test>:{pass,fail,skip,runs,confidence,cause,insufficient?}}}
#   (`runs` = passes actually executed; `runs_requested` = N; `early_exit` = stopped before N.
#    Per test: `insufficient:true` (and confidence forced to null instead of a false 1.0) whenever
#    that test's own `runs` < `runs_requested` — it did not report in every requested pass, so its
#    green-proof is not yet earned. `insufficient_runs` lists those fqcns at the top level.)
# Modes: RERUN_DRY=1 (print cmd) · RERUN_FROM_LOG=file (parse+causes from an existing log; no run)
#        RERUN_EARLY_EXIT=0 forces the full N passes (default 1: decisive-stop + drop-proven-flaky)
#        RERUN_LIB_ONLY=1 (TEST SEAM): source just the functions above (parse_outcomes/aggregate/
#        build_result) without running the CLI body — used by core/tests/rerun-test.sh so the
#        aggregation logic is unit-testable without invoking gradle/Selenoid.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; CFG="$HERE/config.json"
command -v jq >/dev/null || { echo "rerun: jq required" >&2; exit 69; }
. "$HERE/_lock.sh"   # A (N6): serialize gradle on this working copy — concurrent --rerun-tasks corrupt build/

strip(){ sed -E 's/\x1b\[[0-9;]*m//g'; }
parse_outcomes(){ strip | grep -oE '[A-Za-z0-9_$]+ > [A-Za-z0-9_]+\(\) (PASSED|FAILED|SKIPPED)' \
  | sed -E 's/^([A-Za-z0-9_$]+) > ([A-Za-z0-9_]+)\(\) (PASSED|FAILED|SKIPPED)$/\1.\2\t\3/'; }
# $1=runs_requested (N). A test whose OWN runs < N did not report in every requested pass — its
# green-proof is incomplete (I11/§5.3: confirm at pass^N, not pass^1) — so it is flagged
# `insufficient:true` and, if that would otherwise have read as a false confidence:1.0
# (pass>0, fail==0 off an undersampled run), confidence is forced to null instead.
aggregate(){ jq -R -n --argjson n "$1" '
  [ inputs|split("\t")|select(length==2)|{t:.[0],o:.[1]} ] | group_by(.t)
  | map({key:.[0].t, value:(
      (map(select(.o=="PASSED"))|length) as $p | (map(select(.o=="FAILED"))|length) as $f | (map(select(.o=="SKIPPED"))|length) as $s
      | ($p+$f+$s) as $runs | ($runs < $n) as $insuff
      | (if ($p+$f)>0 then ($p/($p+$f)) else null end) as $rawconf
      | {pass:$p,fail:$f,skip:$s,runs:$runs,
         confidence:(if $insuff and $rawconf==1 then null else $rawconf end)}
        + (if $insuff then {insufficient:true} else {} end))})
  | from_entries'; }
# parse + aggregate + attach a failure CAUSE per failed test (so all-fail is diagnosable)
build_result(){ # $1=stripped-combined-log  $2=runs_requested (N — see aggregate() above)
  local lf="$1" n="$2" tests causes='{}' t m c
  tests="$(parse_outcomes < "$lf" | aggregate "$n")"
  for t in $(echo "$tests" | jq -r 'to_entries[]|select(.value.fail>0)|.key'); do
    m="${t##*.}"
    c="$(grep -A3 "> ${m}() FAILED" "$lf" | grep -m1 -E 'Exception|Error:' | sed -E 's/^[[:space:]]+//' | cut -c1-110)"
    [ -n "$c" ] || c="(no per-test cause line)"
    causes="$(echo "$causes" | jq --arg t "$t" --arg c "$c" '.+{($t):$c}')"
  done
  echo "$tests" | jq --argjson c "$causes" 'to_entries|map(.value+={cause:($c[.key]//null)})|from_entries'
}

# TEST SEAM: RERUN_LIB_ONLY=1 sources just the functions above (parse_outcomes/aggregate/build_result)
# without executing the CLI body below — lets core/tests/rerun-test.sh unit-test the aggregation
# (a pure function of parsed outcomes + runs_requested) with synthetic pass logs, no gradle/Selenoid.
if [ "${RERUN_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

if [ -n "${RERUN_FROM_LOG:-}" ]; then _t="$(mktemp)"; strip < "$RERUN_FROM_LOG" > "$_t"; build_result "$_t" 1; rm -f "$_t"; exit 0; fi

TESTS="${1:-}"; TB="${2:-}"
[ -n "$TESTS" ] && [ -n "$TB" ] || { echo "usage: rerun.sh <fqcn-csv> <tb>" >&2; exit 64; }
printf '%s' "$TB"|grep -qE '^[0-9]+$' || { echo "I1: tb must be numeric: $TB" >&2; exit 77; }
printf '%s' "$TESTS"|grep -qE '^[A-Za-z0-9_.,]+$' || { echo "I1: bad FQCN list rejected" >&2; exit 77; }

REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
WD="$(jq -r '.run.workdir' "$CFG")"
# portability: HEKTOR_FK_JAVA_HOME wins; config value (a local toolchain path) is the default; else $JAVA_HOME.
# (ES/jira hosts are NOT env-overridable by design — they're the allowlist-gated security seam; edit config.json.)
JH="${HEKTOR_FK_JAVA_HOME:-$(jq -r '.run.java_home // empty' "$CFG")}"; JH="${JH:-${JAVA_HOME:-}}"
{ [ -n "$JH" ] && [ -d "$JH" ]; } || echo "rerun: WARN JAVA_HOME unresolved ('$JH') — set HEKTOR_FK_JAVA_HOME or run.java_home (toolchain needs JDK 17)" >&2
PROF="$(jq -r '.run.profile' "$CFG")"; LP="$(jq -r '.run.launchpad' "$CFG")"
DC="$(jq -r '.run.data_center' "$CFG")"; BR="$(jq -r '.run.browser' "$CFG")"
SEL="$(jq -r '.run.select_flag' "$CFG")"; N="${RERUN_N:-$(jq -r '.run.flaky_confidence_runs' "$CFG")}"   # RERUN_N overrides config (e.g. fast single-pass cross-box check)

base_cmd=(env "JAVA_HOME=$JH" "$REPO/$WD/gradlew" -p "$REPO/$WD" test --rerun-tasks --no-build-cache
     "-Dspring.profiles.active=$PROF" "-Denv.launchpad=$LP" "-Denv.data.center=$DC"
     "-Dui.testbox=$TB" "-Dui.browser.type=$BR" "--console=plain")
while IFS= read -r e; do base_cmd+=("-x" "$e"); done < <(jq -r '.run.gradle_excludes[]' "$CFG")
run_pass(){ "${base_cmd[@]}" "$SEL=$1" > "$2" 2>&1 || true; }   # $1=test-csv  $2=logfile

if [ "${RERUN_DRY:-0}" = "1" ]; then printf 'DRY-RUN (×%s):\n' "$N"; printf '%q ' "${base_cmd[@]}" "$SEL=$TESTS"; echo; exit 0; fi

# --- I9 box-health cross-check (read-only ES): is THIS box generally green? ---
box_health='null'
if command -v curl >/dev/null; then
  ES="$(jq -r '.es.host + .es.endpoint' "$CFG")"
  bh="$(curl -sk -m 15 -X POST "$ES" -H 'Content-Type: application/json' \
     -d "$(jq -n --argjson tb "$TB" '{size:0,query:{bool:{must:[{term:{testbox:$tb}},{range:{"@timestamp":{gte:"now-12d"}}}]}},aggs:{s:{terms:{field:"testStatus.keyword"}}}}')" 2>/dev/null \
     | jq -c '(.aggregations.s.buckets//[]) | ((map(select(.key=="PASSED"))[0].doc_count)//0) as $p | ((map(select(.key=="FAILED"))[0].doc_count)//0) as $f | {pass:$p,fail:$f,rate:(if ($p+$f)>0 then (($p*100/($p+$f))|floor/100) else null end)}' 2>/dev/null)"
  [ -n "$bh" ] && box_health="$bh"
fi

# --- run N times, KEEP logs ---
# N4: keep logs for diagnosis but GC old ones; LOCAL-TRANSIENT + UNSCRUBBED (raw stackTraces/PII) — never ship (I7)
BASE="${TMPDIR:-/tmp}/hektor-flaky-rerun"; mkdir -p "$BASE"
find "$BASE" -maxdepth 1 -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true   # GC logdirs >1 day
LOGDIR="$(mktemp -d "$BASE/tb${TB}.XXXXXX")"
echo "rerun: re-running on tb$TB ×$N via Selenoid (slow); logs in $LOGDIR" >&2
gradle_lock_acquire "$REPO/$WD"   # A: wait out any concurrent gradle on this working copy (auto-released on exit)
healthy="$(echo "$box_health" | jq '(.rate // 0) >= 0.8')"
EARLY="${RERUN_EARLY_EXIT:-1}"   # 1 = decisive-stop + drop-proven-flaky from later passes (Selenoid dominates wall-clock); 0 = always N full passes
runs_with_tests=0; passes_done=0; cur="$TESTS"; passlogs=()
for i in $(seq 1 "$N"); do
  lf="$LOGDIR/r$i.log"; passlogs+=("$lf")
  run_pass "$cur" "$lf"; passes_done=$((passes_done+1))
  grep -qE '[A-Za-z0-9_$]+ > [A-Za-z0-9_]+\(\) (PASSED|FAILED|SKIPPED)' "$lf" && runs_with_tests=$((runs_with_tests+1))

  { [ "$EARLY" = "1" ] && [ "$i" -lt "$N" ]; } || continue
  cat "${passlogs[@]}" | strip > "$LOGDIR/combined.txt"
  agg="$(build_result "$LOGDIR/combined.txt" "$N")"   # runs_requested — the decisive-stop/narrowing checks below only read .pass/.fail, so this is safe pre-early-exit
  # DECISIVE-STOP: healthy box + uniform reproduce (every executed test fail-only) + cluster >=5 → real; more passes won't move it.
  if [ "$(echo "$agg" | jq --argjson h "${healthy:-false}" '$h and (length>=5) and (all(.[]; .pass==0 and .fail>0))')" = "true" ]; then
    echo "rerun: early-exit after pass $passes_done — healthy box + all $(echo "$agg"|jq 'length') tests reproduce (fail-only); skipping remaining." >&2; break
  fi
  # NARROW: drop classes whose every method has flipped (proven flaky: both a pass AND a fail seen) from later passes.
  # Always a SUBSET of the pass-1 selector (each kept entry demonstrably ran) + default-KEEP on any uncertainty → never the N1 "ran 0 tests" trap.
  ambc="$(echo "$agg" | jq -r 'to_entries|map(select(.value.pass==0 or .value.fail==0))|map(.key|split(".")[0])|unique|.[]' 2>/dev/null)"
  flkc="$(echo "$agg" | jq -r 'to_entries|map(select(.value.pass>0 and .value.fail>0))|map(.key|split(".")[0])|unique|.[]' 2>/dev/null)"
  next=""; IFS=',' read -ra ENT <<<"$cur"
  for e in "${ENT[@]}"; do sc="${e##*.}"
    if   printf '%s\n' "$ambc" | grep -qx "$sc"; then next="${next:+$next,}$e"   # still ambiguous → keep
    elif printf '%s\n' "$flkc" | grep -qx "$sc"; then :                          # fully proven flaky → drop
    else next="${next:+$next,}$e"; fi                                            # unmatched → default-keep
  done
  if [ -z "$next" ]; then echo "rerun: early-exit after pass $passes_done — every test decided (proven flaky); skipping remaining." >&2; break; fi
  cur="$next"
done
cat "$LOGDIR"/r*.log | strip > "$LOGDIR/combined.txt"
tests="$(build_result "$LOGDIR/combined.txt" "$N")"   # runs_requested — I11: per-test completeness vs the full N, not just passes-done

EFF_N="$passes_done"                                          # passes actually run (≤ N when early-exit fired)
incomplete=$(( EFF_N - runs_with_tests ))
allfail="$(echo "$tests" | jq '(([.[].pass]|add)//0)==0 and (length>=5)')"
broken_box="$(jq -n --argjson af "$allfail" --argjson h "${healthy:-false}" '$af and ($h|not)')"   # box itself looks broken
anomalous="$(jq -n --argjson inc "$incomplete" '$inc>0')"  # untrustworthy run = a pass ran but executed NOTHING (early-exit is NOT anomalous: EFF_N counts only passes done)
insufficient_runs="$(echo "$tests" | jq -c '[to_entries[]|select(.value.insufficient==true)|.key]')"

echo "$tests" | jq --arg tb "$TB" --argjson n "$EFF_N" --argjson nreq "$N" --argjson rwt "$runs_with_tests" --argjson inc "$incomplete" \
  --argjson bh "$box_health" --argjson bb "$broken_box" --argjson an "$anomalous" --arg ld "$LOGDIR" --argjson ir "$insufficient_runs" \
  '{tb:$tb, runs:$n, runs_requested:$nreq, early_exit:($n<$nreq), runs_with_tests:$rwt, incomplete_runs:$inc, box_health:$bh,
    broken_box_suspected:$bb, run_anomalous:$an, logdir:$ld, insufficient_runs:$ir, tests:.}'
