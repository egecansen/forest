#!/bin/bash
# core/summary.sh — convergence report from the ledger (the artifact you review + commit against).
#
# Enforces: I7 — emit ONLY allowlisted fields (sig, status, test count); never raw stackTrace / PII / tokens.
# Contract: ledger JSON (stdin) → human-readable report.
set -uo pipefail
command -v jq >/dev/null || { echo "summary: jq required" >&2; exit 69; }

jq -r '
  # I7 (G-3): emit ONLY structured tokens (bucket/exception-type/tier). The committed report must
  # never carry the raw signature — it is a lightly-normalized slice of the stackTrace and can hold
  # PII/secrets (an exception MESSAGE like "expected: <sk_live_…>"). label = exception TYPE only
  # (no message) — the v2 ledger schema (kernel §8) persists `.bucket` / `.signature` / `.tier`;
  # `.recipe` / `.sig` / `.tier_hint` are cluster.sh pre-ledger fields and never exist here — reading
  # them silently rendered every entry as "uncategorized".
  def etype: (. // "") | [scan("[A-Za-z_][A-Za-z0-9_.]*(?:Exception|Error|FailedError|Failure)")] | (.[0] // null);
  def safelabel: ( .bucket // (.signature | etype) // "uncategorized" );
  def sec(title; st):
    "\n## \(title)\n" +
    ( [ .clusters[] | select(.status==st) | "  - [\(safelabel)]  \(.tests|length) test(s)" ]
      | if length>0 then join("\n") else "  (none)" end );
  # 5th "still flaky" section was structurally dead: it filtered status=="flaky", which is not a
  # legal status (TERMINAL = green/deferred/flagged/resolved-upstream — all four already have their
  # own section above) — it could never render anything but "(none)". Dropped rather than folded:
  # there is no leftover terminal status to fold it into. kernel.md §9 updated to the real 4 sections.
  "# Flaky-triage summary — build \(.run.build // "?")  tb \(.run.tb // "?")"
  + sec("✅ fixed (green-proofed)";        "green")
  + sec("🐛 suspected bug (TODO + evidence — NOT filed)"; "flagged")
  + sec("⏭ deferred";                     "deferred")
  + sec("↩ resolved upstream";            "resolved-upstream")
  + "\n\n(You review the diff and commit — the kit never does.)"
'
