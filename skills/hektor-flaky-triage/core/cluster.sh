#!/bin/bash
# core/cluster.sh — group FAILED docs into clusters by ROOT-CAUSE signature.
#
# Enforces: V6 (root cause, not line 1; unwrap MultipleFailures) · I6 (per-cluster cap; log drops)
# Contract: ingest JSON (stdin) → stdout JSON [ {sig,count,sample,recipe,tier_hint,boxes,tests:[fqcn]} ]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HERE/config.json"
command -v jq >/dev/null || { echo "cluster: jq required" >&2; exit 69; }

out="$(jq --slurpfile cfg "$CFG" '
  def lines(st): (st // "") | split("\n") | map(select(length>0));
  # V6: root cause = first Exception/Error line; if MultipleFailures, prefer the nested cause
  def rootline(st):
    lines(st) as $l
    | ($l | map(select(test("Exception|Error"))) | .[0]) as $first
    | if ($first|type)=="string" and ($first|test("MultipleFailures"))
      then ($l | map(select(test("Exception|Error|expected:|but was:|\\[")))[1] // $first)
      else ($first // ($l[0] // "EMPTY")) end;
  def norm(s): s | gsub("^\\s+";"") | gsub("[0-9]+";"N") | gsub("_cllpsID_a[A-Za-z0-9]+";"_cllpsID")
                 | gsub("Unable to locate element.*";"Unable to locate element")   # merge NoSuchElement-by-selector
                 | gsub("\\s+";" ") | .[0:100];

  ($cfg[0]) as $c
  | [ .fails[] | (rootline(.stackTrace)) as $r
      | {test:.testName, fqcn:.testPath, kure:.testKure, tb:.testbox, sample:($r|.[0:130]), raw:$r, sig:norm($r)} ]
  | group_by(.sig)
  | map({ sig:.[0].sig, count:length, sample:.[0].sample,
          boxes:([.[].tb]|unique), fqcns:[.[].fqcn],
          recipe:( .[0].raw as $s | $c.recipes | map(select(.match as $m | ($s|test($m)))) | .[0].id // null),
          tests:[.[].test] })
  | map(. + {
      bucket:((.sig // "") | [scan("[A-Za-z_][A-Za-z0-9_.]*(?:Exception|Error|FailedError|Failure)")] | (.[0] // null)),
      tier_hint:
      (if   .recipe=="generated-collapse-id"      then "T1/T3 selector-relocate"
       elif .recipe=="onetrust-dismiss"           then "T1 env(onetrust)"
       elif .recipe=="filter-value-by-text-empty" then "T2 data/flag — control-box rerun"
       elif (.sig|test("VisualRegression"))        then "env(VRT) advisory"
       elif (.sig|test("NoSuchBean"))              then "infra (user/feature backend absent)"
       elif (.sig|test("MultipleFailures|AssertionFailed")) then "T2/T4 assertion — evidence-gate"
       else "T? triage" end)})
  | sort_by(-.count)
  # I6 (G-2): enforce bounds — cap tests/iteration largest-first, keep ≥per_cluster_keep_min per signature
  | ($c.bounds.max_tests_per_iteration // 60) as $cap
  | ($c.bounds.per_cluster_keep_min // 1) as $keep
  | (reduce .[] as $cl ({rem:$cap, out:[]};
       ($cl.tests|length) as $n
       | ([ $n, ([.rem, $keep] | max) ] | min) as $take
       | { rem:(.rem - $take),
           out:(.out + [ $cl + {tests:($cl.tests[0:$take]), tests_total:$n, dropped:($n-$take)} ]) })
    ).out
')" || exit $?

# I6 (G-2): surface trims to the human (per-cluster tests_total/dropped carry the detail)
drop="$(printf '%s' "$out" | jq '[.[].dropped] | add // 0' 2>/dev/null || echo 0)"
if [ "${drop:-0}" -gt 0 ] 2>/dev/null; then
  echo "cluster: I6 cap — trimmed $drop test(s) beyond bounds.max_tests_per_iteration (kept ≥$(jq -r '.bounds.per_cluster_keep_min // 1' "$CFG") per signature)." >&2
fi
printf '%s\n' "$out"
