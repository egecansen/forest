#!/bin/bash
# core/gate.sh — the pass^N verification GATE. Turns rerun.sh's per-test confidence
# into a machine-checkable accept/reject/inconclusive verdict, so "fixed" is a
# deterministic decision, not the fixer grading its own work.
#
# Enforces: I11/kernel §5.3 (confirm at pass^N, not pass^1) · I9 (an untrustworthy box/run
#           decides NOTHING — the oracle, not the fix, is in doubt)
#
# Adopted from ECC:
#   - pass^N=1.00 as the release-critical bar   (skills/eval-harness/SKILL.md:254-258)
#   - the verifier-result artifact shape         (examples/evaluator-rag-prototype/verifier-result.json)
#   - "must be able to say no" / a rejected sibling proves the gate can reject
#     (docs/architecture/evaluator-rag-prototype.md:143-152)
#
# Contract:  rerun.sh JSON on stdin  ->  verifier-result.json on stdout.
# rerun.sh emits: {tb,runs,runs_requested,early_exit,runs_with_tests,incomplete_runs,box_health,
#   broken_box_suspected,run_anomalous,logdir,insufficient_runs:[<fqcn>...],
#   tests:{<t>:{pass,fail,skip,runs,confidence,cause,insufficient?}}}
#
# Per-test decision (N = runs_requested), first match wins:
#   inconclusive : run/box untrustworthy (broken_box_suspected or run_anomalous)
#   rejected     : fail>0                             (still red / still flaky — NOT fixed)
#   inconclusive : insufficient==true                 (rerun.sh's own "looked green, not proven" flag)
#   accepted     : pass>0 AND fail==0 AND runs>=N AND confidence==1.0   (pass^N proof)
#   inconclusive : under-proven, or nothing executed
#
# NOTE on `insufficient` (this is the kit-specific adaptation — the ECC-era gate predates it):
# rerun.sh sets `insufficient:true` and FORCES `confidence:null` exactly when
# `fail==0 && runs>0 && runs<runs_requested` — a test that would otherwise read as a false green
# off an undersampled run. Without an explicit branch the null confidence still lands in an
# `inconclusive` bucket (null != 1.0), but with the generic "under-proven" reason; branching on the
# flag keeps the gate's reason string aligned with rerun.sh's own vocabulary, so a reader is never
# left reconciling two different names for the same condition. A test with fail>0 is a DECIDED,
# non-green verdict and is never flagged insufficient however undersampled (RERUN_EARLY_EXIT can
# legitimately stop it early) — which is why the `rejected` branch is checked FIRST.
#
# A green fix is "fixed" ONLY if it is `accepted` here AND an independent reviewer
# subagent approves (the two-key rule — see the flaky-triage SKILL.md).
#
# Env: GATE_BUILD=<pinned @timestamp>  (optional, recorded for traceability)
#      GATE_TS=<iso8601>               (optional; else `date -u`)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76
JQ="$(command -v jq || true)"; [ -n "$JQ" ] || { echo "gate: jq required" >&2; exit 69; }

IN="$(cat)"
printf '%s' "$IN" | "$JQ" -e '.tests' >/dev/null 2>&1 || { echo "gate: stdin is not rerun.sh JSON (no .tests)" >&2; exit 64; }

TS="${GATE_TS:-$(date -u +%FT%TZ 2>/dev/null || echo '?')}"

printf '%s' "$IN" | "$JQ" \
  --arg ts "$TS" --arg build "${GATE_BUILD:-}" '
  . as $r
  | ($r.runs_requested // $r.runs // 3) as $N
  | (($r.broken_box_suspected // false) or ($r.run_anomalous // false)) as $untrustworthy
  | {
      schema_version: "hektor.flaky.verifier.v1",
      generated_at: $ts,
      build: (if $build == "" then null else $build end),
      tb: $r.tb,
      runs_requested: $N,
      runs: $r.runs,
      early_exit: ($r.early_exit // false),
      insufficient_runs: ($r.insufficient_runs // []),
      read_only: true,
      box_health: $r.box_health,
      untrustworthy: $untrustworthy,
      candidates: [
        $r.tests | to_entries[] | .key as $t | .value as $v
        | ($v.pass // 0) as $p | ($v.fail // 0) as $f | ($v.runs // 0) as $runs
        | ($v.confidence) as $conf
        | ($v.insufficient // false) as $insuff
        | (
            if $untrustworthy then
              { decision: "inconclusive",
                reasons: ["run/box untrustworthy: broken_box_suspected or run_anomalous — the oracle, not the fix, is in doubt"] }
            elif $f > 0 and $p > 0 then
              { decision: "rejected",
                reasons: ["confidence \($conf) over \($runs) runs — still flaky, not fixed"] }
            elif $f > 0 then
              { decision: "rejected",
                reasons: ["\($f)/\($runs) runs still FAILED — not fixed (or a suspected app-bug to flag, never to mask)"] }
            elif $insuff then
              { decision: "inconclusive",
                reasons: ["rerun.sh flagged insufficient: green over \($runs) of N=\($N) requested runs — it did not report in every pass, so the green-proof is not earned (confidence nulled, not 1.0)"] }
            elif $p > 0 and $f == 0 and $runs >= $N and ($conf == 1.0) then
              { decision: "accepted",
                reasons: ["pass^N: confidence==1.0 over \($runs) runs (N=\($N)), fail==0"] }
            elif $p > 0 and $f == 0 then
              { decision: "inconclusive",
                reasons: ["under-proven: \($runs) green runs < N=\($N) — one green run is not proof (a flake passes ~half the time)"] }
            else
              { decision: "inconclusive",
                reasons: ["no PASS/FAIL executed (\($runs) runs, skip-only?) — nothing to prove"] }
            end
          ) as $d
        | {
            candidate_id: $t,
            decision: $d.decision,
            score: $conf,
            runs: $runs,
            runs_requested: $N,
            fail: $f,
            insufficient: $insuff,
            reasons: $d.reasons,
            rollback: "revert the diff for \($t); it returns to its prior state; no suite/commit touched"
          }
      ]
    }
  | .summary = {
      accepted:     ([.candidates[]|select(.decision=="accepted")]     | length),
      rejected:     ([.candidates[]|select(.decision=="rejected")]     | length),
      inconclusive: ([.candidates[]|select(.decision=="inconclusive")] | length)
    }
  | .all_accepted = (.summary.rejected == 0 and .summary.inconclusive == 0 and .summary.accepted > 0)
  '
