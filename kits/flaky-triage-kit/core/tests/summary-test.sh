#!/bin/bash
# First test suite for core/summary.sh (v2 schema). Plain bash asserts, no framework.
# Builds a real v2 ledger via ledger.sh subcommands (never hand-crafted JSON) and pipes it through
# summary.sh, matching the documented contract: `ledger.sh get FILE | summary.sh`.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER="$HERE/../ledger.sh"
SUMMARY="$HERE/../summary.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
F="$TMP/ledger.json"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

"$LEDGER" init "$F" >/dev/null 2>&1

# green cluster, labeled via .bucket
"$LEDGER" cluster-upsert "$F" c-green --title "Selector drift" --bucket selector --tests "com.x.AaTest" >/dev/null 2>&1
"$LEDGER" cluster-state  "$F" c-green selected >/dev/null 2>&1
"$LEDGER" cluster-state  "$F" c-green applied --passes 3 --runs 3 >/dev/null 2>&1
"$LEDGER" cluster-state  "$F" c-green green >/dev/null 2>&1

# flagged cluster, no bucket — label must derive from .signature's exception TYPE only. The
# signature carries a secret-shaped substring that must never leak into the committed report (I7).
SECRET="sk_live_ABCDEFGH123456"
"$LEDGER" cluster-upsert "$F" c-flagged --title "Suspected race" \
  --signature "java.lang.AssertionError: expected token $SECRET but was null" \
  --tests "com.x.BbTest" >/dev/null 2>&1
"$LEDGER" cluster-state "$F" c-flagged selected >/dev/null 2>&1
"$LEDGER" cluster-state "$F" c-flagged flagged >/dev/null 2>&1

# deferred cluster, no bucket + no signature -> falls back to "uncategorized"
"$LEDGER" cluster-upsert "$F" c-deferred --title "Env dependent" --tests "com.x.CcTest,com.x.DdTest" >/dev/null 2>&1
"$LEDGER" cluster-state "$F" c-deferred selected >/dev/null 2>&1
"$LEDGER" cluster-state "$F" c-deferred deferred >/dev/null 2>&1

# resolved-upstream cluster, labeled via .bucket
"$LEDGER" cluster-upsert "$F" c-upstream --title "3rd party outage" --bucket infra --tests "com.x.EeTest" >/dev/null 2>&1
"$LEDGER" cluster-state "$F" c-upstream selected >/dev/null 2>&1
"$LEDGER" cluster-state "$F" c-upstream resolved-upstream >/dev/null 2>&1

OUT="$("$LEDGER" get "$F" | "$SUMMARY")"

# --- each §9 section renders, from the RIGHT fields (.bucket / .signature — not the never-persisted
# .recipe / .sig / .tier_hint, which would silently render every entry as "uncategorized")
case "$OUT" in *"fixed (green-proofed)"*) ok ;; *) bad "fixed section header present" ;; esac
case "$OUT" in *"suspected bug"*) ok ;; *) bad "flagged section header present" ;; esac
case "$OUT" in *"deferred"*) ok ;; *) bad "deferred section header present" ;; esac
case "$OUT" in *"resolved upstream"*) ok ;; *) bad "resolved-upstream section header present" ;; esac
case "$OUT" in *"[selector]"*) ok ;; *) bad "green entry labeled via .bucket (selector)" ;; esac
case "$OUT" in *"[infra]"*) ok ;; *) bad "resolved-upstream entry labeled via .bucket (infra)" ;; esac
case "$OUT" in *"[java.lang.AssertionError]"*) ok ;; *) bad "flagged entry labeled via exception-type derived from .signature" ;; esac
case "$OUT" in *"[uncategorized]"*) ok ;; *) bad "no-bucket/no-signature entry falls back to uncategorized" ;; esac

# --- test counts per entry (bucket label + "N test(s)")
case "$OUT" in *"[uncategorized]  2 test(s)"*) ok ;; *) bad "deferred entry shows correct test count (2)" ;; esac

# --- dead status=="flaky" section (never a legal status) is gone, not left rendering "(none)" forever
case "$OUT" in *"still flaky"*) bad "dead 'still flaky' section must be removed" ;; *) ok ;; esac
case "$OUT" in *"🌀"*) bad "dead flaky-section emoji must be removed" ;; *) ok ;; esac

# --- I7: emit ONLY structured tokens — no raw signature / secret substring anywhere in the report
case "$OUT" in *"$SECRET"*) bad "I7 leak: raw secret from .signature appeared in summary output" ;; *) ok ;; esac
case "$OUT" in *"expected token"*) bad "I7 leak: raw signature text appeared in summary output" ;; *) ok ;; esac
case "$OUT" in *"AssertionError: expected"*) bad "I7 leak: raw signature text (with exception type prefix) appeared" ;; *) ok ;; esac

echo "summary-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
