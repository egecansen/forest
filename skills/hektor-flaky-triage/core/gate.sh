#!/bin/bash
# core/gate.sh — the pass^N verification GATE. Turns rerun.sh's per-test confidence
# into a machine-checkable accept/reject/inconclusive verdict, so "fixed" is a
# deterministic decision, not the fixer grading its own work.
#
# Adopted from ECC:
#   - pass^N=1.00 as the release-critical bar   (skills/eval-harness/SKILL.md:254-258)
#   - the verifier-result artifact shape         (examples/evaluator-rag-prototype/verifier-result.json)
#   - "must be able to say no" / a rejected sibling proves the gate can reject
#     (docs/architecture/evaluator-rag-prototype.md:143-152)
#
# Contract:  rerun.sh JSON on stdin  ->  verifier-result.json on stdout.
# rerun.sh emits: {tb,runs,runs_requested,early_exit,runs_with_tests,incomplete_runs,
#   box_health,broken_box_suspected,run_anomalous,logdir, tests:{<t>:{pass,fail,skip,runs,confidence,cause}}}
#
# Per-test decision (N = runs_requested):
#   accepted     : pass>0 AND fail==0 AND runs>=N AND confidence==1.0    (pass^N proof)
#   rejected     : fail>0                                                (still red / still flaky — NOT fixed)
#   inconclusive : under-proven (runs<N), or the run/box is untrustworthy (broken box / anomalous run)
# A green fix is "fixed" ONLY if it is `accepted` here AND an independent reviewer
# subagent approves (the two-key rule — see the flaky-triage SKILL.md).
#
# Env: GATE_BUILD=<pinned @timestamp>  (optional, recorded for traceability)
#      GATE_TS=<iso8601>               (optional; else `date -u`)
set -uo pipefail
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
      read_only: true,
      box_health: $r.box_health,
      untrustworthy: $untrustworthy,
      candidates: [
        $r.tests | to_entries[] | .key as $t | .value as $v
        | ($v.pass // 0) as $p | ($v.fail // 0) as $f | ($v.runs // 0) as $runs
        | ($v.confidence) as $conf
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
