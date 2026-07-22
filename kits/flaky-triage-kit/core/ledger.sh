#!/bin/bash
# core/ledger.sh — run-state I/O (resumable, auditable). v2: presentation contract (kernel §8).
#
# Enforces: I5 — callers re-derive "already applied" from SOURCE, never trust this ledger for a safety decision.
#           I11 — `validate --final` is the machine gate: no session ends with selected/applied clusters.
# Writes: route ALL mutations through cluster-upsert / cluster-state / event (kernel P2). `set` remains
# for exotic repairs only. Untrusted values bind via --arg (jq-injection discipline).
set -uo pipefail
command -v jq >/dev/null || { echo "ledger: jq required" >&2; exit 69; }
CMD="${1:-}"; FILE="${2:-}"
[ -n "$CMD" ] && [ -n "$FILE" ] || { echo "usage: ledger.sh init|get|set|cluster-upsert|cluster-state|event|validate <file> [...]" >&2; exit 64; }

BUCKETS="easy-fix selector vrt app-change infra likely-bug"
PHASES="ingest confirm cluster pick fix verify report"
TERMINAL="green deferred flagged resolved-upstream"
FQCN_RE='^[A-Za-z_][A-Za-z0-9_.]*(#[A-Za-z0-9_]+)?$'
ID_RE='^[a-z0-9-]{1,40}$'

die() { echo "ledger: $1" >&2; exit "${2:-65}"; }
has_word() { case " $1 " in *" $2 "*) return 0;; *) return 1;; esac; }
jset() { local flt="$1"; shift; local tmp; tmp="$(mktemp)"; jq "$@" "$flt" "$FILE" > "$tmp" && mv "$tmp" "$FILE"; }

# transition <from> <to> → 0 ok / 1 reject. Same-status updates allowed for count/test refreshes.
transition_ok() {
  local from="$1" to="$2"
  [ "$from" = "$to" ] && { has_word "$TERMINAL" "$from" && return 1 || return 0; }
  has_word "$TERMINAL" "$from" && return 1
  case "$from:$to" in
    proposed:selected|proposed:deferred|proposed:resolved-upstream) return 0;;
    selected:applied|selected:deferred|selected:flagged|selected:resolved-upstream) return 0;;
    applied:green|applied:flagged|applied:deferred|applied:resolved-upstream) return 0;;
    *) return 1;;
  esac
}

case "$CMD" in
  init) jq -n '{run:{version:2}, clusters:[], events:[]}' > "$FILE"; echo "ledger: initialized $FILE (v2)" >&2 ;;
  get)  jq -r "${3:-.}" "$FILE" ;;
  set)  flt="${3:?ledger set: need a jq filter}"; shift 3
        tmp="$(mktemp)"; jq "$@" "$flt" "$FILE" > "$tmp" && mv "$tmp" "$FILE" ;;

  cluster-upsert)
    ID="${3:-}"; [ -n "$ID" ] || die "cluster-upsert: need <id>" 64; shift 3
    printf '%s' "$ID" | grep -qE "$ID_RE" || die "invalid cluster id: $ID"
    ARGS=(); TESTS_CSV=""
    while [ $# -gt 0 ]; do case "$1" in
      --title)      [ ${#2} -le 80 ]  || die "title >80 chars";  ARGS+=(--arg title "$2");  shift 2;;
      --detail)     [ ${#2} -le 600 ] || die "detail >600 chars"; ARGS+=(--arg detail "$2"); shift 2;;
      --bucket)     has_word "$BUCKETS" "$2" || die "invalid bucket: $2"; ARGS+=(--arg bucket "$2"); shift 2;;
      --tier)       printf '%s' "$2" | grep -qE '^[1-4]$' || die "tier must be 1-4"; ARGS+=(--arg tier "$2"); shift 2;;
      --signature)  ARGS+=(--arg signature "$2"); shift 2;;
      --fix-vs-bug) ARGS+=(--arg fixVsBug "$2"); shift 2;;
      --tests)      TESTS_CSV="$2"; shift 2;;
      *) die "cluster-upsert: unknown flag $1" 64;;
    esac; done
    TESTS_JSON="[]"
    if [ -n "$TESTS_CSV" ]; then
      IFS=',' read -ra FQ <<< "$TESTS_CSV"
      for f in "${FQ[@]}"; do printf '%s' "$f" | grep -qE "$FQCN_RE" || die "invalid fqcn: $f"; done
      TESTS_JSON="$(printf '%s\n' "${FQ[@]}" | jq -R '{fqcn:.}' | jq -s '.')"
    fi
    jset '
      (if any(.clusters[]; .id==$id) then . else .clusters += [{id:$id, status:"proposed", tests:[]}] end)
      | .clusters |= map(if .id==$id then
          . + ($ARGS.named | with_entries(select(.key != "id")))
          + (if ($tests | length) > 0 then {tests:$tests} else {} end)
        else . end)' \
      --arg id "$ID" --argjson tests "$TESTS_JSON" "${ARGS[@]}" ;;

  cluster-state)
    ID="${3:-}"; TO="${4:-}"; [ -n "$ID" ] && [ -n "$TO" ] || die "cluster-state: need <id> <status>" 64; shift 4
    has_word "proposed selected applied $TERMINAL" "$TO" || die "invalid status: $TO"
    FROM="$(jq -r --arg id "$ID" '.clusters[] | select(.id==$id) | .status // empty' "$FILE")"
    [ -n "$FROM" ] || die "unknown cluster id: $ID" 66
    transition_ok "$FROM" "$TO" || die "invalid transition: $FROM → $TO"
    PASSES=""; RUNS=""; TESTUPS=()
    while [ $# -gt 0 ]; do case "$1" in
      --passes) printf '%s' "$2" | grep -qE '^[0-9]+$' || die "passes must be integer"; PASSES="$2"; shift 2;;
      --runs)   printf '%s' "$2" | grep -qE '^[0-9]+$' || die "runs must be integer";   RUNS="$2";   shift 2;;
      --test)   fq="${2%%=*}"; st="${2#*=}"
                printf '%s' "$fq" | grep -qE "$FQCN_RE" || die "invalid fqcn: $fq"
                has_word "red green skipped" "$st" || die "invalid test status: $st"
                TESTUPS+=("$fq=$st"); shift 2;;
      *) die "cluster-state: unknown flag $1" 64;;
    esac; done
    if [ -n "$PASSES" ] && [ -n "$RUNS" ]; then [ "$PASSES" -le "$RUNS" ] || die "passes > runs"; fi
    jset '.clusters |= map(if .id==$id then .status=$to
            | (if $passes != "" then .passes=($passes|tonumber) else . end)
            | (if $runs   != "" then .runs=($runs|tonumber)     else . end)
          else . end)' \
      --arg id "$ID" --arg to "$TO" --arg passes "${PASSES}" --arg runs "${RUNS}"
    for up in ${TESTUPS[@]+"${TESTUPS[@]}"}; do
      jset '.clusters |= map(if .id==$id then
              .tests |= (map(if .fqcn==$fq then .status=$st else . end)
                         + (if any(.[]; .fqcn==$fq) then [] else [{fqcn:$fq, status:$st}] end))
            else . end)' \
        --arg id "$ID" --arg fq "${up%%=*}" --arg st "${up#*=}"
    done ;;

  event)
    WHAT="${3:-}"; [ -n "$WHAT" ] || die "event: need <what>" 64; shift 3
    PHASE=""; WHO="${USER:-unknown}"
    while [ $# -gt 0 ]; do case "$1" in
      --phase) has_word "$PHASES" "$2" || die "invalid phase: $2"; PHASE="$2"; shift 2;;
      --who)   WHO="$2"; shift 2;;
      *) die "event: unknown flag $1" 64;;
    esac; done
    jset '.events += [{who:$who, what:$what, when:$when}
                      + (if $phase != "" then {phase:$phase} else {} end)]' \
      --arg who "$WHO" --arg what "$WHAT" --arg when "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "$PHASE" ;;

  validate)
    MODE="${3:-}"
    jq -e 'type=="object" and (.clusters|type=="array") and (.events|type=="array")' "$FILE" >/dev/null \
      || die "not a ledger: missing clusters/events arrays"
    BAD="$(jq -r '[.clusters[] | select(
        (.id? // "" | test("'"$ID_RE"'") | not) or
        ((.status? // "proposed") as $s | ["proposed","selected","applied","green","deferred","flagged","resolved-upstream"] | index($s) | not) or
        ((.title? // "" | length) > 80) or ((.detail? // "" | length) > 600) or
        (has("passes") and has("runs") and .passes > .runs)
      ) | .id // "?"] | join(",")' "$FILE")"
    [ -z "$BAD" ] || die "schema violations in clusters: $BAD"
    if [ "$MODE" = "--final" ]; then
      OPEN="$(jq -r '[.clusters[] | select(.status=="selected" or .status=="applied") | .id] | join(",")' "$FILE")"
      [ -z "$OPEN" ] || { echo "ledger: NOT FINAL — non-terminal selected/applied clusters: $OPEN" >&2; exit 67; }
    fi
    echo "ledger: valid${MODE:+ ($MODE)}" >&2 ;;

  *) echo "ledger: unknown cmd '$CMD'" >&2; exit 64 ;;
esac
# I5 reminder: before apply, check the fix's presence in CURRENT source — not this ledger. P7: integrity/locking for shared use.
