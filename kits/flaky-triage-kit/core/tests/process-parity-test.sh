#!/bin/bash
# core/process.json is the process vocabulary; core/ledger.sh restates it as bash strings so the
# I11 gate never depends on a second file being readable. Two statements of one thing drift — this
# suite is what stops them.
#
# It does not compare text. It EXERCISES ledger.sh: every name process.json declares is offered to
# the real script, and every name it does not declare is offered too. A vocabulary the engine
# accepts but the contract never mentions is the same defect as the reverse — that is exactly how
# `confirm` came to live in the ledger and in no driver's UI.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER="$HERE/../ledger.sh"
PROC="$HERE/../process.json"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
F="$TMP/ledger.json"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

command -v jq >/dev/null || { echo "process-parity-test: jq required" >&2; exit 69; }
[ -f "$PROC" ] || { echo "FAIL: core/process.json is missing — it is the source the rest of this suite checks against" >&2; exit 1; }

jq -e . "$PROC" >/dev/null 2>&1 && ok || bad "process.json must be valid JSON"
[ "$(jq -r '.schema' "$PROC")" = "hektor-flaky-triage/process@1" ] \
  && ok || bad "process.json must declare its schema id"

fresh() { rm -f "$F"; "$LEDGER" init "$F" >/dev/null 2>&1; }

# --- phases ------------------------------------------------------------------------------------
# `event --phase X` is the only gate on the phase vocabulary, so drive it directly.
PHASES_DECLARED="$(jq -r '.phases | sort_by(.order) | .[].id' "$PROC")"
fresh
while read -r p; do
  [ -n "$p" ] || continue
  "$LEDGER" event "$F" phase-enter --phase "$p" >/dev/null 2>&1 \
    && ok || bad "phase '$p' is declared in process.json but ledger.sh rejects it"
done <<< "$PHASES_DECLARED"

# ...and nothing outside the declaration is accepted. `health-check` and `converge` are the two
# plausible names a driver would reach for; `confirm` used to be accepted while meaning two
# different things depending on where you read the list.
for bogus in health-check converge apply triage; do
  "$LEDGER" event "$F" phase-enter --phase "$bogus" >/dev/null 2>&1 \
    && bad "ledger.sh accepts phase '$bogus', which process.json never declares" || ok
done

# The order is the contract a driver renders. `confirm` after `pick` is the whole reason this
# check exists: reversed, a forward-only phase display drops every confirm event silently.
[ "$(printf '%s' "$PHASES_DECLARED" | tr '\n' ' ')" = "ingest cluster pick confirm fix verify report" ] \
  && ok || bad "phase ORDER changed — a driver renders this order; update INTEGRATION.md and every driver, then this line"

# --- cluster statuses --------------------------------------------------------------------------
STATUSES="$(jq -r '.clusterStatus | keys_unsorted[]' "$PROC")"
[ "$(printf '%s\n' "$STATUSES" | sort | tr '\n' ' ')" \
  = "applied deferred flagged green proposed resolved-upstream selected " ] \
  && ok || bad "cluster status set changed — kernel §8's enum, INTEGRATION.md and every driver render it"

# Terminal-ness is behavioural: a terminal status refuses to advance to a non-terminal one, and
# `validate --final` passes only when nothing is left selected/applied.
while read -r s; do
  [ -n "$s" ] || continue
  declared_terminal="$(jq -r --arg s "$s" '.clusterStatus[$s].terminal' "$PROC")"
  fresh
  "$LEDGER" cluster-upsert "$F" c1 --title t >/dev/null 2>&1
  # walk to $s along its own declared path
  case "$s" in
    proposed) : ;;
    selected) "$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1 ;;
    applied)  "$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1
              "$LEDGER" cluster-state "$F" c1 applied  >/dev/null 2>&1 ;;
    # green is the only terminal status a fix must be APPLIED to reach — `selected → green`
    # would be a verdict on work that never landed, so the walk goes through applied.
    green)    "$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1
              "$LEDGER" cluster-state "$F" c1 applied  >/dev/null 2>&1
              "$LEDGER" cluster-state "$F" c1 green    >/dev/null 2>&1 ;;
    *)        "$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1
              "$LEDGER" cluster-state "$F" c1 "$s"     >/dev/null 2>&1 ;;
  esac
  [ "$("$LEDGER" get "$F" '.clusters[0].status')" = "$s" ] \
    && ok || bad "could not reach status '$s' by its declared transitions"
  if "$LEDGER" validate "$F" --final >/dev/null 2>&1; then reached_terminal=true; else reached_terminal=false; fi
  # proposed is not terminal but is not "open work" either — I11 only blocks selected/applied.
  if [ "$s" != "proposed" ]; then
    [ "$reached_terminal" = "$declared_terminal" ] \
      && ok || bad "status '$s': process.json says terminal=$declared_terminal, validate --final says $reached_terminal"
  fi
done <<< "$STATUSES"

# Every declared transition is accepted, and every undeclared one is refused. This is the pair
# that keeps `to:` honest — a lenient engine and a strict contract read identically until a driver
# trusts the contract.
while read -r from; do
  [ -n "$from" ] || continue
  while read -r to; do
    [ -n "$to" ] || continue
    [ "$from" = "$to" ] && continue
    fresh
    "$LEDGER" cluster-upsert "$F" c1 --title t >/dev/null 2>&1
    case "$from" in
      proposed) : ;;
      selected) "$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1 ;;
      applied)  "$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1
                "$LEDGER" cluster-state "$F" c1 applied  >/dev/null 2>&1 ;;
      green)    "$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1
                "$LEDGER" cluster-state "$F" c1 applied  >/dev/null 2>&1
                "$LEDGER" cluster-state "$F" c1 green    >/dev/null 2>&1 ;;
      *)        "$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1
                "$LEDGER" cluster-state "$F" c1 "$from"  >/dev/null 2>&1 ;;
    esac
    # A `continue` here would silently drop every transition out of a status the walk cannot
    # reach — the reopen rules live exactly there, so failing to set it up is a test failure.
    [ "$("$LEDGER" get "$F" '.clusters[0].status')" = "$from" ] \
      || { bad "test setup: could not park a cluster in '$from' to try '$from → $to'"; continue; }
    declared="$(jq -r --arg f "$from" --arg t "$to" \
      '.clusterStatus[$f].to // [] | index($t) != null' "$PROC")"
    if "$LEDGER" cluster-state "$F" c1 "$to" >/dev/null 2>&1; then accepted=true; else accepted=false; fi
    [ "$accepted" = "$declared" ] \
      && ok || bad "transition $from → $to: process.json says allowed=$declared, ledger.sh says $accepted"
  done <<< "$STATUSES"
done <<< "$STATUSES"

# --- buckets -----------------------------------------------------------------------------------
BUCKETS_DECLARED="$(jq -r '.buckets | sort_by(.order) | .[].id' "$PROC")"
fresh
while read -r b; do
  [ -n "$b" ] || continue
  "$LEDGER" cluster-upsert "$F" "b-$b" --title t --bucket "$b" >/dev/null 2>&1 \
    && ok || bad "bucket '$b' is declared in process.json but ledger.sh rejects it"
done <<< "$BUCKETS_DECLARED"
for bogus in redesign timeout unknown; do
  "$LEDGER" cluster-upsert "$F" "x-$bogus" --title t --bucket "$bogus" >/dev/null 2>&1 \
    && bad "ledger.sh accepts bucket '$bogus', which process.json never declares" || ok
done
# The presentation order is what "easy-fix → likely-bug" means; a driver sorts by it.
[ "$(printf '%s' "$BUCKETS_DECLARED" | tr '\n' ' ')" = "easy-fix selector vrt app-change infra likely-bug" ] \
  && ok || bad "bucket ORDER changed — the table is ordered easy-fix → likely-bug by it"

# `validate` re-states the bucket + status lists inside its own jq filter. That third copy is the
# one most likely to be forgotten, so check it can actually read a ledger using every declared name.
"$LEDGER" validate "$F" >/dev/null 2>&1 \
  && ok || bad "validate rejects a ledger built from process.json's own declared buckets"

# --- tiers + test statuses ---------------------------------------------------------------------
fresh
"$LEDGER" cluster-upsert "$F" c1 --title t >/dev/null 2>&1
while read -r tier; do
  [ -n "$tier" ] || continue
  "$LEDGER" cluster-upsert "$F" "t-$tier" --title t --tier "$tier" >/dev/null 2>&1 \
    && ok || bad "tier '$tier' is declared in process.json but ledger.sh rejects it"
done < <(jq -r '.tiers[].id' "$PROC")
"$LEDGER" cluster-upsert "$F" t-5 --title t --tier 5 >/dev/null 2>&1 \
  && bad "ledger.sh accepts tier 5, which process.json never declares" || ok

"$LEDGER" cluster-state "$F" c1 selected >/dev/null 2>&1
while read -r ts; do
  [ -n "$ts" ] || continue
  "$LEDGER" cluster-state "$F" c1 selected --test "com.x.Foo=$ts" >/dev/null 2>&1 \
    && ok || bad "test status '$ts' is declared in process.json but ledger.sh rejects it"
done < <(jq -r '.testStatus[]' "$PROC")
"$LEDGER" cluster-state "$F" c1 selected --test "com.x.Foo=flaky" >/dev/null 2>&1 \
  && bad "ledger.sh accepts test status 'flaky', which process.json never declares" || ok

# --- the ledger path convention ----------------------------------------------------------------
# The convention exists so callers stop inventing paths; process.json states it and `path` must
# produce it, or a driver reading the contract lands somewhere the engine does not.
DIR="$(jq -r '.ledger.dir' "$PROC")"
( cd "$TMP" && git init -q . 2>/dev/null
  P="$("$LEDGER" path web-test-s4-flaky-1394 2>/dev/null)"
  case "$P" in */"$DIR"/ledger-web-test-s4-flaky-1394.json) exit 0;; *) exit 1;; esac ) \
  && ok || bad "ledger.sh path does not produce process.json's declared '$DIR/ledger-<build>.json'"

HEKTOR_LEDGER_DIR="$TMP/custom" "$LEDGER" path b1 >/dev/null 2>&1 \
  && [ -d "$TMP/custom" ] \
  && ok || bad "HEKTOR_LEDGER_DIR must relocate the ledger dir and create it"

"$LEDGER" path '../escape' >/dev/null 2>&1 \
  && bad "ledger.sh path must reject a traversing build name" || ok

# --- rounds ------------------------------------------------------------------------------------
# I10's "max iterations" half. Without a counter nothing bounded re-clustering at all.
fresh
[ "$("$LEDGER" round "$F")" = "1" ] && ok || bad "a fresh ledger starts at round 1"
"$LEDGER" cluster-upsert "$F" r1c --title t >/dev/null 2>&1
"$LEDGER" round-next "$F" >/dev/null 2>&1
[ "$("$LEDGER" round "$F")" = "2" ] && ok || bad "round-next must advance the round"
"$LEDGER" cluster-upsert "$F" r2c --title t >/dev/null 2>&1
[ "$("$LEDGER" get "$F" '.clusters[] | select(.id=="r1c") | .round')" = "1" ] \
  && ok || bad "a cluster keeps the round it was first proposed in"
[ "$("$LEDGER" get "$F" '.clusters[] | select(.id=="r2c") | .round')" = "2" ] \
  && ok || bad "a cluster proposed after round-next carries the new round"
"$LEDGER" cluster-upsert "$F" r1c --title "retitled" >/dev/null 2>&1
[ "$("$LEDGER" get "$F" '.clusters[] | select(.id=="r1c") | .round')" = "1" ] \
  && ok || bad "re-upserting a cluster must NOT restamp its round — that is what erases history"

MAXR="$(jq -r '.bounds.max_rounds' "$HERE/../config.json")"
[ -n "$MAXR" ] && [ "$MAXR" != "null" ] \
  && ok || bad "config.json must carry bounds.max_rounds — I10's bound has no other home"
while [ "$("$LEDGER" round "$F")" -lt "$MAXR" ]; do "$LEDGER" round-next "$F" >/dev/null 2>&1 || break; done
"$LEDGER" round-next "$F" >/dev/null 2>&1 \
  && bad "round-next must refuse past bounds.max_rounds (I10)" || ok

# A ledger written before rounds existed has no .run.round and must read as round 1, not error.
printf '%s' '{"run":{"version":2},"clusters":[],"events":[]}' > "$F"
[ "$("$LEDGER" round "$F")" = "1" ] \
  && ok || bad "a pre-rounds ledger must read as round 1"

echo "process-parity-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
