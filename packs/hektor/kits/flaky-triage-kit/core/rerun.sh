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
#    Per test: `insufficient:true` (and confidence forced to null instead of a false 1.0) ONLY when
#    that test has NO observed failures (fail==0 — it would otherwise read as green) AND its own
#    `runs` < `runs_requested` — it did not report in every requested pass, so its green-proof is
#    not yet earned. A test with >=1 observed failure is a DECIDED, non-green verdict (no
#    false-green risk) and is never flagged insufficient, however undersampled — Round2 Fix B:
#    `insufficient` <=> `fail==0 && runs>0 && runs<runs_requested`. `insufficient_runs` lists those
#    fqcns at the top level.)
# Modes: RERUN_DRY=1 (print cmd) · RERUN_FROM_LOG=file (parse+causes from an existing log; no run)
#        RERUN_EARLY_EXIT=0 forces the full N passes (default 1: decisive-stop + drop-proven-flaky)
#        RERUN_LIB_ONLY=1 (TEST SEAM): source just the functions above (parse_outcomes/aggregate/
#        build_result) without running the CLI body — used by core/tests/rerun-test.sh so the
#        aggregation logic is unit-testable without invoking gradle/Selenoid.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; CFG="$HERE/config.json"
command -v jq >/dev/null || { echo "rerun: jq required" >&2; exit 69; }
. "$HERE/_lock.sh"   # A (N6): serialize gradle on this working copy — concurrent cleanTest runs corrupt build/
. "$HERE/_strict.sh"   # Round3: shared whole-string shape matcher (closes the grep-newline anchor bypass)

strip(){ sed -E 's/\x1b\[[0-9;]*m//g'; }
parse_outcomes(){ strip | grep -oE '[A-Za-z0-9_$]+ > [A-Za-z0-9_]+\(\) (PASSED|FAILED|SKIPPED)' \
  | sed -E 's/^([A-Za-z0-9_$]+) > ([A-Za-z0-9_]+)\(\) (PASSED|FAILED|SKIPPED)$/\1.\2\t\3/'; }
# $1=runs_requested (N). Round2 Fix B: `insufficient` means ONLY "looked green but not proven over
# N" — i.e. it fires ONLY when a test has NO observed failures (fail==0, so it would otherwise read
# as green) AND its own runs < N (it did not report in every requested pass — I11/§5.3: confirm at
# pass^N, not pass^1). A test with >=1 observed failure already has a DECIDED, non-green verdict —
# no false-green risk — and must never be flagged insufficient, however undersampled (e.g.
# RERUN_EARLY_EXIT decisively stopped it early). `insufficient <=> fail==0 && runs>0 && runs<n`.
# When insufficient, confidence is forced to null instead of a false 1.0 (fail==0 always yields
# rawconf of 1 or null, so nulling is always correct here, never a nulled honest partial value).
aggregate(){ jq -R -n --argjson n "$1" '
  [ inputs|split("\t")|select(length==2)|{t:.[0],o:.[1]} ] | group_by(.t)
  | map({key:.[0].t, value:(
      (map(select(.o=="PASSED"))|length) as $p | (map(select(.o=="FAILED"))|length) as $f | (map(select(.o=="SKIPPED"))|length) as $s
      | ($p+$f+$s) as $runs | ($f==0 and $runs>0 and $runs < $n) as $insuff
      | (if ($p+$f)>0 then ($p/($p+$f)) else null end) as $rawconf
      | {pass:$p,fail:$f,skip:$s,runs:$runs,
         confidence:(if $insuff then null else $rawconf end)}
        + (if $insuff then {insufficient:true} else {} end))})
  | from_entries'; }
# parse + aggregate + attach a failure CAUSE per failed test (so all-fail is diagnosable)
# Gradle prints "ClassName > method() PASSED" — the PACKAGE is not on that line, so
# parse_outcomes can only ever key on the simple name. The ledger keys on FQCNs (ledger.sh's
# FQCN_RE), and gate.sh passes these keys straight through as `candidate_id`, so every consumer
# was left holding `FooTest.a` where it needed `com.x.FooTest.a` and doing the translation by
# hand — which nothing did. Two same-named classes in different packages merged into ONE verdict.
#
# The information is right here: the caller told us the FQCNs. `rekey_to_fqcn` maps each simple
# key back to the FQCN that was asked for.
#
# When two REQUESTED fqcns share a simple name the log genuinely cannot tell them apart — that
# is missing information, not a puzzle to solve. Both are emitted under their own fqcn, marked
# `ambiguous` and forced `insufficient`, which gate.sh already turns into `inconclusive`. An
# honest "we could not tell" beats a verdict assigned to a coin flip.
#
# $1 = the requested fqcn csv. A key with no match is passed through unchanged (RERUN_FROM_LOG
# has no request list, and a stray test in the log is not ours to rename).
rekey_to_fqcn(){
  local csv="${1:-}"
  [ -n "$csv" ] || { cat; return 0; }
  jq --arg csv "$csv" '
    ($csv | split(",") | map(select(length>0))) as $req
    | ($req | map({simple: (split(".") | .[-2:] | join(".")), fq: .})
            | group_by(.simple)
            | map({key: .[0].simple, value: map(.fq)})
            | from_entries) as $bysimple
    | . as $tests
    | reduce ($tests | keys_unsorted[]) as $k (
        {};
        ($bysimple[$k] // []) as $matches
        | if ($matches | length) == 0 then . + {($k): $tests[$k]}
          elif ($matches | length) == 1 then . + {($matches[0]): $tests[$k]}
          else . + (reduce $matches[] as $fq ({};
              . + {($fq): ($tests[$k] + {ambiguous: true, insufficient: true, confidence: null})}))
          end)'
}

build_result(){ # $1=stripped-combined-log  $2=runs_requested (N)  $3=requested fqcn csv (optional)
  local lf="$1" n="$2" req="${3:-}" tests causes='{}' t m c
  tests="$(parse_outcomes < "$lf" | aggregate "$n" | rekey_to_fqcn "$req")"
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

. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76

if [ -n "${RERUN_FROM_LOG:-}" ]; then _t="$(mktemp)"; strip < "$RERUN_FROM_LOG" > "$_t"; build_result "$_t" 1; rm -f "$_t"; exit 0; fi

TESTS="${1:-}"; TB="${2:-}"
[ -n "$TESTS" ] && [ -n "$TB" ] || { echo "usage: rerun.sh <fqcn-csv> <tb>" >&2; exit 64; }
TBN="$(normalize_tb "$TB")" || { echo "I1: tb must be a testbox id (161 or tb161): $TB" >&2; exit 77; }
TB="$TBN"
# Round3: strict_match is WHOLE-STRING (unlike line-oriented `grep -qE '^...$'`) — rejects an
# embedded-newline FQCN-CSV that would otherwise smuggle a metacharacter-laden line past this check.
strict_match "$TESTS" '[A-Za-z0-9_.,]+' || { echo "I1: bad FQCN list rejected" >&2; exit 77; }

REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
WD="$(jq -r '.run.workdir' "$CFG")"
# portability: HEKTOR_FK_JAVA_HOME wins; config value (a local toolchain path) is the default; else $JAVA_HOME.
# (ES/jira hosts are NOT env-overridable by design — they're the allowlist-gated security seam; edit config.json.)
JH="${HEKTOR_FK_JAVA_HOME:-$(jq -r '.run.java_home // empty' "$CFG")}"; JH="${JH:-${JAVA_HOME:-}}"
{ [ -n "$JH" ] && [ -d "$JH" ]; } || echo "rerun: WARN JAVA_HOME unresolved ('$JH') — set HEKTOR_FK_JAVA_HOME or run.java_home (toolchain needs JDK 17)" >&2
PROF="$(jq -r '.run.profile' "$CFG")"; LP="$(jq -r '.run.launchpad' "$CFG")"
DC="${HEKTOR_FK_DATA_CENTER:-$(jq -r '.run.data_center' "$CFG")}"; BR="$(jq -r '.run.browser' "$CFG")"
SEL="$(jq -r '.run.select_flag' "$CFG")"; N="${RERUN_N:-$(jq -r '.run.flaky_confidence_runs' "$CFG")}"   # RERUN_N overrides config (e.g. fast single-pass cross-box check)

# `cleanTest test`, NOT `--rerun-tasks`. Both force the test task to re-execute
# instead of being skipped UP-TO-DATE, but --rerun-tasks also re-runs
# :generate-method-plugin:instrumentCode, after which the -Dtests-named method is
# no longer discovered and every pass returns "No tests were executed!" — which
# the gate then grades run_anomalous, so a rerun can never produce a verdict.
# This is the invocation web-test/CLAUDE.md documents; see its gradle section.
base_cmd=(env "JAVA_HOME=$JH" "$REPO/$WD/gradlew" -p "$REPO/$WD" cleanTest test --no-build-cache
     "-Dspring.profiles.active=$PROF" "-Denv.launchpad=$LP" "-Denv.data.center=$DC"
     # -Dapi.url is MANDATORY: client.properties has no default for it
     # (`api.url=${sys:api.url}`), so without it the Spring context never loads
     # and every test reports FAILED with UnknownHostException — an environment
     # failure the gate would otherwise grade as a real red verdict.
     # Format per web-test/CLAUDE.md: <dc>tb<dc><id>.
     "-Dapi.url=${API_URL:-${DC}tb${DC}${TB}}"
     "-Dui.testbox=$TB" "-Dui.browser.type=$BR" "--console=plain")
# Optional selenoid browser pin (hektor-conventions "mandatory -D set"). Opt-in via config: an
# EMPTY chrome_version passes nothing, so behaviour is unchanged unless the box actually pins a
# version. Validated like every other externally-supplied value (I1) — a version is digits and
# dots, nothing else — even though base_cmd is an ARRAY (no word-splitting, no eval), because the
# value still reaches gradle as a -D and a junk pin fails every run in a confusing way.
CV="${HEKTOR_FK_CHROME_VERSION:-$(jq -r '.run.chrome_version // ""' "$CFG")}"
if [ -n "$CV" ]; then
  strict_match "$CV" '[0-9]+(\.[0-9]+)*' || { echo "I1: bad run.chrome_version rejected: $CV" >&2; exit 77; }
  base_cmd+=("-Dchrome.version=$CV")
fi
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
# Health is TRI-state: measured-good, measured-bad, or not measured at all. `(.rate // 0)`
# collapsed the last two into `false`, so "ES told us nothing" was indistinguishable from "this
# box is sick" — and every conclusion built on `healthy` inherited that confusion.
health_known="$(echo "$box_health" | jq 'type=="object" and (.rate != null)')"
healthy="$(echo "$box_health" | jq '(.rate != null) and (.rate >= 0.8)')"
EARLY="${RERUN_EARLY_EXIT:-1}"   # 1 = decisive-stop + drop-proven-flaky from later passes (Selenoid dominates wall-clock); 0 = always N full passes
runs_with_tests=0; passes_done=0; cur="$TESTS"; passlogs=()
for i in $(seq 1 "$N"); do
  lf="$LOGDIR/r$i.log"; passlogs+=("$lf")
  run_pass "$cur" "$lf"; passes_done=$((passes_done+1))
  grep -qE '[A-Za-z0-9_$]+ > [A-Za-z0-9_]+\(\) (PASSED|FAILED|SKIPPED)' "$lf" && runs_with_tests=$((runs_with_tests+1))

  { [ "$EARLY" = "1" ] && [ "$i" -lt "$N" ]; } || continue
  cat "${passlogs[@]}" | strip > "$LOGDIR/combined.txt"
  agg="$(build_result "$LOGDIR/combined.txt" "$N" "$TESTS")"   # runs_requested — the decisive-stop/narrowing checks below only read .pass/.fail, so this is safe pre-early-exit
  # DECISIVE-STOP: healthy box + uniform reproduce (every executed test fail-only) + cluster >=5 → real; more passes won't move it.
  if [ "$(echo "$agg" | jq --argjson h "${healthy:-false}" '$h and (length>=5) and (all(.[]; .pass==0 and .fail>0))')" = "true" ]; then
    echo "rerun: early-exit after pass $passes_done — healthy box + all $(echo "$agg"|jq 'length') tests reproduce (fail-only); skipping remaining." >&2; break
  fi
  # NARROW: drop classes whose every method has flipped (proven flaky: both a pass AND a fail seen) from later passes.
  # Always a SUBSET of the pass-1 selector (each kept entry demonstrably ran) + default-KEEP on any uncertainty → never the N1 "ran 0 tests" trap.
  # Both sides must name the CLASS, and neither did. The keys were compared on
  # `split(".")[0]` — the first segment, which for `com.x.FooTest.a` is `com` — while each
  # entry used `${e##*.}`, the LAST segment, which is the method. Class names were matched
  # against method names, nothing ever matched, and every entry fell to default-keep: the
  # optimisation silently did nothing, and reported nothing, for as long as it has existed.
  #
  # A class is the second-to-last segment once `#` is normalised to `.`, so `com.x.FooTest.a`
  # and `com.x.FooTest#a` both yield `FooTest`, and a bare `FooTest.a` still does too. A bare
  # CLASS selector (`com.x.FooTest`, meaning every method) yields the package segment instead
  # and therefore matches nothing — which lands on default-keep, the safe direction this
  # block already takes on any uncertainty. Losing the optimisation costs a pass; guessing
  # wrong costs a verdict.
  ambc="$(echo "$agg" | jq -r 'to_entries|map(select(.value.pass==0 or .value.fail==0))|map(.key|gsub("#";".")|split(".")|(.[-2] // .[0]))|unique|.[]' 2>/dev/null)"
  flkc="$(echo "$agg" | jq -r 'to_entries|map(select(.value.pass>0 and .value.fail>0))|map(.key|gsub("#";".")|split(".")|(.[-2] // .[0]))|unique|.[]' 2>/dev/null)"
  next=""; IFS=',' read -ra ENT <<<"$cur"
  for e in "${ENT[@]}"; do _c="${e//#/.}"; _c="${_c%.*}"; sc="${_c##*.}"
    if   printf '%s\n' "$ambc" | grep -qx "$sc"; then next="${next:+$next,}$e"   # still ambiguous → keep
    elif printf '%s\n' "$flkc" | grep -qx "$sc"; then :                          # fully proven flaky → drop
    else next="${next:+$next,}$e"; fi                                            # unmatched → default-keep
  done
  if [ -z "$next" ]; then echo "rerun: early-exit after pass $passes_done — every test decided (proven flaky); skipping remaining." >&2; break; fi
  cur="$next"
done
cat "$LOGDIR"/r*.log | strip > "$LOGDIR/combined.txt"
tests="$(build_result "$LOGDIR/combined.txt" "$N" "$TESTS")"   # runs_requested — I11: per-test completeness vs the full N, not just passes-done

EFF_N="$passes_done"                                          # passes actually run (≤ N when early-exit fired)
incomplete=$(( EFF_N - runs_with_tests ))
# I9's protection, and it used to require `length>=5` — but a PICKED cluster is typically 1-3
# tests, so it never applied where verdicts are actually made. A sick box failing all three of
# them was graded `rejected` ("still red, suspected app-bug") instead of `inconclusive`, which
# points the operator at the wrong culprit. The size floor added nothing that `healthy` was not
# already carrying: this fires only when the box's OWN health probe says it is unwell.
allfail="$(echo "$tests" | jq '(([.[].pass]|add)//0)==0 and (length>0)')"
# Requires MEASURED ill health, not merely the absence of a measurement. Without `health_known`,
# a setup where the ES aggregation returns nothing would call every all-fail cluster a broken
# box — and then no real failure could ever be confirmed, because "run more" would be the answer
# to everything.
broken_box="$(jq -n --argjson af "$allfail" --argjson h "${healthy:-false}" --argjson k "${health_known:-false}" '$af and $k and ($h|not)')"
# VOID-RUN DETECTION (web-test/CLAUDE.md, "Never trust BUILD SUCCESSFUL").
# The `incomplete` check above only catches a pass that printed no test line at
# all. These catch the worse case: a pass that printed FAILED for every test
# because the environment never came up. Without this, a missing -Dapi.url, a
# flag that didn't land, or an UP-TO-DATE replay is graded `rejected` — "still
# red, suspected app-bug" — which is a wrong verdict, not an error.
void_reason=""
if grep -qE 'UnknownHostException: api\.url|Failed to load ApplicationContext' "$LOGDIR/combined.txt" 2>/dev/null; then
  void_reason="context never loaded (api.url / Spring) — the run is void, not red"
elif grep -qE 'initializationError' "$LOGDIR/combined.txt" 2>/dev/null; then
  void_reason="test initialization error — the run is void, not red"
elif grep -qE 'Task :test UP-TO-DATE' "$LOGDIR/combined.txt" 2>/dev/null; then
  void_reason="gradle replayed cached output; zero tests ran"
elif grep -qE 'testbox : production' "$LOGDIR/combined.txt" 2>/dev/null; then
  void_reason="flags did not land (testbox reported as production)"
fi
[ -n "$void_reason" ] && echo "rerun: VOID RUN — $void_reason. See $LOGDIR." >&2

anomalous="$(jq -n --argjson inc "$incomplete" --arg void "$void_reason" '$inc>0 or ($void|length)>0')"  # untrustworthy run = a pass ran but executed NOTHING, or the environment never came up (early-exit is NOT anomalous: EFF_N counts only passes done)
insufficient_runs="$(echo "$tests" | jq -c '[to_entries[]|select(.value.insufficient==true)|.key]')"

echo "$tests" | jq --arg tb "$TB" --argjson n "$EFF_N" --argjson nreq "$N" --argjson rwt "$runs_with_tests" --argjson inc "$incomplete" \
  --argjson bh "$box_health" --argjson bhk "${health_known:-false}" --argjson bb "$broken_box" --argjson an "$anomalous" --arg ld "$LOGDIR" --argjson ir "$insufficient_runs" \
  '{tb:$tb, runs:$n, runs_requested:$nreq, early_exit:($n<$nreq), runs_with_tests:$rwt, incomplete_runs:$inc, box_health:$bh, box_health_known:$bhk,
    broken_box_suspected:$bb, run_anomalous:$an, logdir:$ld, insufficient_runs:$ir, tests:.}'
