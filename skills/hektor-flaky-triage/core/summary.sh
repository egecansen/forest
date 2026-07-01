#!/bin/bash
# core/summary.sh — convergence report from the ledger (the artifact you review + commit against).
#
# Enforces: I7 — emit ONLY allowlisted fields (sig, status, test count); never raw stackTrace / PII / tokens.
# Contract: ledger JSON (stdin) → human-readable report.
set -uo pipefail
command -v jq >/dev/null || { echo "summary: jq required" >&2; exit 69; }

jq -r '
  # I7 (G-3): emit ONLY structured tokens (recipe/bucket/tier). The committed report must never
  # carry the raw sig — it is a lightly-normalized slice of the stackTrace and can hold PII/secrets
  # (an exception MESSAGE like "expected: <sk_live_…>"). bucket = exception TYPE only (no message).
  def etype: (. // "") | [scan("[A-Za-z_][A-Za-z0-9_.]*(?:Exception|Error|FailedError|Failure)")] | (.[0] // null);
  def safelabel: ( .recipe // .bucket // (.sig | etype) // .tier_hint // "uncategorized" );
  def sec(title; st):
    "\n## \(title)\n" +
    ( [ .clusters[] | select(.status==st) | "  - [\(safelabel)]  \(.tests|length) test(s)" ]
      | if length>0 then join("\n") else "  (none)" end );
  "# Flaky-triage summary — build \(.run.build // "?")  tb \(.run.tb // "?")"
  + sec("✅ fixed (green-proofed)";        "green")
  + sec("🐛 suspected bug (TODO + evidence — NOT filed)"; "flagged")
  + sec("⏭ deferred";                     "deferred")
  + sec("🌀 still flaky";                  "flaky")
  + sec("↩ resolved upstream";            "resolved-upstream")
  + "\n\n(You review the diff and commit — the kit never does.)"
'
