#!/bin/bash
# core/ledger.sh — run-state I/O (resumable, auditable). v2: presentation contract (kernel §8).
#
# Enforces: I5 — callers re-derive "already applied" from SOURCE, never trust this ledger for a safety decision.
#           I11 — `validate --final` is the machine gate: no session ends with selected/applied clusters.
# Writes: route ALL mutations through cluster-upsert / cluster-state / event (kernel P2). `set` remains
# for exotic repairs only. Untrusted values bind via --arg (jq-injection discipline).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76
command -v jq >/dev/null || { echo "ledger: jq required" >&2; exit 69; }
CMD="${1:-}"; FILE="${2:-}"
[ -n "$CMD" ] && [ -n "$FILE" ] || { echo "usage: ledger.sh init|get|set|cluster-upsert|cluster-state|cluster-vrt|event|validate <file> [...]" >&2; exit 64; }

BUCKETS="easy-fix selector vrt app-change infra likely-bug"
PHASES="ingest confirm cluster pick fix verify report"
TERMINAL="green deferred flagged resolved-upstream"
FQCN_RE='^[A-Za-z_][A-Za-z0-9_.]*(#[A-Za-z0-9_]+)?$'
ID_RE='^[a-z0-9-]{1,40}$'
TIER_RE='^[1-4]$'
INT_RE='^[0-9]+$'
VRT_RE='^https://vrt-[^[:space:]]+$'

die() { echo "ledger: $1" >&2; exit "${2:-65}"; }
has_word() { case " $1 " in *" $2 "*) return 0;; *) return 1;; esac; }

# --- P7: write serialization -------------------------------------------------------------------
# jset()/the inline `set` do a read-modify-write (jq … > tmp && mv tmp file). With N concurrent
# writers unlocked, every writer reads the SAME pre-write snapshot and the last `mv` wins — the
# others' updates are silently lost (observed: 40 concurrent `event` calls → 55% dropped). Fix:
# hold an exclusive lock across the read-modify-write. Prefer the real `flock` syscall where
# present (Linux); macOS ships no `flock` binary, so fall back to a portable `mkdir` spinlock
# (mkdir is atomic even over NFS/most filesystems — the classic portable-lock primitive). Bounded
# retry + trap-release on exit/interrupt so a killed holder can't wedge every future writer forever.
_LEDGER_LOCKFD="200"
_LEDGER_LOCKDIR=""
ledger_unlock() {
  if [ -n "$_LEDGER_LOCKDIR" ]; then rmdir "$_LEDGER_LOCKDIR" 2>/dev/null || true; _LEDGER_LOCKDIR=""; fi
  eval "exec ${_LEDGER_LOCKFD}>&-" 2>/dev/null || true
}
ledger_lock() { # $1 = file the lock protects
  local target="$1" waited=0
  trap 'ledger_unlock' EXIT INT TERM
  if command -v flock >/dev/null 2>&1; then
    eval "exec ${_LEDGER_LOCKFD}>\"\$target.lock\""
    flock -w 30 "$_LEDGER_LOCKFD" || die "lock timeout on $target" 75
    return 0
  fi
  until mkdir "$target.lock.d" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -ge 600 ] && die "lock timeout on $target" 75   # 600 * 0.05s = 30s cap
    sleep 0.05
  done
  _LEDGER_LOCKDIR="$target.lock.d"
}
jset() {
  local flt="$1"; shift; local tmp rc=0
  ledger_lock "$FILE"
  tmp="$(mktemp "${FILE}.XXXXXX")" || { ledger_unlock; die "jset: mktemp failed"; }
  if jq "$@" "$flt" "$FILE" > "$tmp"; then mv "$tmp" "$FILE"; rc=$?; else rc=$?; rm -f "$tmp"; fi
  ledger_unlock
  return "$rc"
}

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
  init)
    FORCE_ARG="${3:-}"
    case "$FORCE_ARG" in
      "") : ;;
      --force) : ;;
      *) die "init: unknown flag $FORCE_ARG (only --force accepted)" 64 ;;
    esac
    if [ -f "$FILE" ] && [ "$FORCE_ARG" != "--force" ]; then
      CLUSTER_COUNT="$(jq -r '(.clusters // []) | length' "$FILE" 2>/dev/null)"
      if [ -n "$CLUSTER_COUNT" ] && [ "$CLUSTER_COUNT" -gt 0 ] 2>/dev/null; then
        die "init: refusing to clobber populated ledger ($CLUSTER_COUNT cluster(s)) at $FILE — pass --force to overwrite" 65
      fi
    fi
    jq -n '{run:{version:2}, clusters:[], events:[]}' > "$FILE"; echo "ledger: initialized $FILE (v2)" >&2 ;;
  get)  jq -r "${3:-.}" "$FILE" ;;
  set)  flt="${3:?ledger set: need a jq filter}"; shift 3
        ledger_lock "$FILE"
        tmp="$(mktemp "${FILE}.XXXXXX")" || { ledger_unlock; die "set: mktemp failed"; }
        if jq "$@" "$flt" "$FILE" > "$tmp"; then mv "$tmp" "$FILE"; rc=$?; else rc=$?; rm -f "$tmp"; fi
        ledger_unlock
        exit "$rc" ;;

  cluster-upsert)
    ID="${3:-}"; [ -n "$ID" ] || die "cluster-upsert: need <id>" 64; shift 3
    [[ "$ID" =~ $ID_RE ]] || die "invalid cluster id: $ID"
    ARGS=(); TESTS_CSV=""; HAS_TESTS="0"
    while [ $# -gt 0 ]; do case "$1" in
      --title)      [ $# -ge 2 ] || die "--title: missing value" 64;      [ ${#2} -le 80 ]  || die "title >80 chars";  ARGS+=(--arg title "$2");  shift 2;;
      --detail)     [ $# -ge 2 ] || die "--detail: missing value" 64;     [ ${#2} -le 600 ] || die "detail >600 chars"; ARGS+=(--arg detail "$2"); shift 2;;
      --bucket)     [ $# -ge 2 ] || die "--bucket: missing value" 64;     has_word "$BUCKETS" "$2" || die "invalid bucket: $2"; ARGS+=(--arg bucket "$2"); shift 2;;
      --tier)       [ $# -ge 2 ] || die "--tier: missing value" 64;       [[ "$2" =~ $TIER_RE ]] || die "tier must be 1-4"; ARGS+=(--arg tier "$2"); shift 2;;
      --signature)  [ $# -ge 2 ] || die "--signature: missing value" 64;  [ ${#2} -le 200 ] || die "signature >200 chars"; ARGS+=(--arg signature "$2"); shift 2;;
      --fix-vs-bug) [ $# -ge 2 ] || die "--fix-vs-bug: missing value" 64; [ ${#2} -le 40 ]  || die "fix-vs-bug >40 chars"; ARGS+=(--arg fixVsBug "$2"); shift 2;;
      --tests)      [ $# -ge 2 ] || die "--tests: missing value" 64;      TESTS_CSV="$2"; HAS_TESTS="1"; shift 2;;
      *) die "cluster-upsert: unknown flag $1" 64;;
    esac; done
    TESTS_JSON="[]"
    if [ -n "$TESTS_CSV" ]; then
      case "$TESTS_CSV" in *$'\n'*) die "invalid --tests: embedded newline";; esac
      IFS=',' read -ra FQ <<< "$TESTS_CSV"
      for f in "${FQ[@]}"; do [[ "$f" =~ $FQCN_RE ]] || die "invalid fqcn: $f"; done
      TESTS_JSON="$(printf '%s\n' "${FQ[@]}" | jq -R '{fqcn:.}' | jq -s '.')"
    fi
    jset '
      (if any(.clusters[]; .id==$id) then . else .clusters += [{id:$id, status:"proposed", tests:[]}] end)
      | .clusters |= map(if .id==$id then
          . + ($ARGS.named | with_entries(select(.key != "id" and .key != "tests" and .key != "hasTests")))
          + (if $hasTests == "1" then {tests:$tests} else {} end)
        else . end)' \
      --arg id "$ID" --argjson tests "$TESTS_JSON" --arg hasTests "$HAS_TESTS" "${ARGS[@]+"${ARGS[@]}"}" ;;

  cluster-state)
    ID="${3:-}"; TO="${4:-}"; [ -n "$ID" ] && [ -n "$TO" ] || die "cluster-state: need <id> <status>" 64; shift 4
    has_word "proposed selected applied $TERMINAL" "$TO" || die "invalid status: $TO"
    FROM="$(jq -r --arg id "$ID" '.clusters[] | select(.id==$id) | .status // empty' "$FILE")"
    [ -n "$FROM" ] || die "unknown cluster id: $ID" 66
    transition_ok "$FROM" "$TO" || die "invalid transition: $FROM → $TO"
    PASSES=""; RUNS=""; TESTUPS=()
    while [ $# -gt 0 ]; do case "$1" in
      --passes) [ $# -ge 2 ] || die "--passes: missing value" 64; [[ "$2" =~ $INT_RE ]] || die "passes must be integer"; PASSES="$2"; shift 2;;
      --runs)   [ $# -ge 2 ] || die "--runs: missing value" 64;   [[ "$2" =~ $INT_RE ]] || die "runs must be integer";   RUNS="$2";   shift 2;;
      --test)   [ $# -ge 2 ] || die "--test: missing value" 64
                fq="${2%%=*}"; st="${2#*=}"
                [[ "$fq" =~ $FQCN_RE ]] || die "invalid fqcn: $fq"
                has_word "red green skipped" "$st" || die "invalid test status: $st"
                TESTUPS+=("$fq=$st"); shift 2;;
      *) die "cluster-state: unknown flag $1" 64;;
    esac; done
    # Cross-call: if only one of passes/runs is given this call, fall back to the stored
    # counterpart so the effective pair is still checked (a lone --passes can't sneak past
    # a previously-recorded --runs, and vice versa).
    if [ -n "$PASSES" ] || [ -n "$RUNS" ]; then
      EFFP="$PASSES"; EFFR="$RUNS"
      [ -n "$EFFP" ] || EFFP="$(jq -r --arg id "$ID" '.clusters[] | select(.id==$id) | .passes // empty' "$FILE")"
      [ -n "$EFFR" ] || EFFR="$(jq -r --arg id "$ID" '.clusters[] | select(.id==$id) | .runs // empty' "$FILE")"
      if [ -n "$EFFP" ] && [ -n "$EFFR" ]; then [ "$EFFP" -le "$EFFR" ] || die "passes > runs"; fi
    fi
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

  cluster-vrt)
    ID="${3:-}"; FQ="${4:-}"; URL="${5:-}"
    [ -n "$ID" ] && [ -n "$FQ" ] && [ -n "$URL" ] || die "cluster-vrt: need <id> <fqcn> <url>" 64
    jq -e --arg id "$ID" 'any(.clusters[]; .id==$id)' "$FILE" >/dev/null || die "unknown cluster id: $ID" 66
    [[ "$FQ"  =~ $FQCN_RE ]] || die "invalid fqcn: $FQ"
    [ ${#URL} -le 500 ] || die "vrt url >500 chars"
    [[ "$URL" =~ $VRT_RE ]] || die "invalid vrt url (must be ^https://vrt- , no whitespace): $URL"
    jset '.clusters |= map(if .id==$id then
            .tests |= (map(if .fqcn==$fq then .vrt=$url else . end)
                       + (if any(.[]; .fqcn==$fq) then [] else [{fqcn:$fq, vrt:$url}] end))
          else . end)' \
      --arg id "$ID" --arg fq "$FQ" --arg url "$URL" ;;

  event)
    WHAT="${3:-}"; [ -n "$WHAT" ] || die "event: need <what>" 64; shift 3
    PHASE=""; WHO="${USER:-unknown}"
    while [ $# -gt 0 ]; do case "$1" in
      --phase) [ $# -ge 2 ] || die "--phase: missing value" 64; has_word "$PHASES" "$2" || die "invalid phase: $2"; PHASE="$2"; shift 2;;
      --who)   [ $# -ge 2 ] || die "--who: missing value" 64;   WHO="$2"; shift 2;;
      *) die "event: unknown flag $1" 64;;
    esac; done
    jset '.events += [{who:$who, what:$what, when:$when}
                      + (if $phase != "" then {phase:$phase} else {} end)]' \
      --arg who "$WHO" --arg what "$WHAT" --arg when "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg phase "$PHASE" ;;

  validate)
    MODE="${3:-}"
    jq -e 'type=="object" and (.clusters|type=="array") and (.events|type=="array")' "$FILE" >/dev/null \
      || die "not a ledger: missing clusters/events arrays"
    # {id, reason} reporting: which rule failed, not just a bare id list. `fullmatch` is the shared
    # whole-string matcher (test(re) AND no embedded newline) — oniguruma's `$` matches just before a
    # trailing newline (Perl semantics), so an anchored regex alone lets "abc\n" pass as "abc"; every
    # regex-shaped field (id/fqcn/vrt/tier) routes through fullmatch so that backstop can't be
    # forgotten on a future field the way it nearly was for bucket/tier here.
    BAD_JSON="$(jq -c '
      def fullmatch(re): test(re) and (test("\n")|not);
      def reason:
        if ((.id? // "") | fullmatch("'"$ID_RE"'") | not) then "bad-id"
        elif (((.status? // "proposed")) as $s
              | (["proposed","selected","applied","green","deferred","flagged","resolved-upstream"] | index($s) | not)) then "bad-status"
        elif ((.title? // "" | length) > 80) then "overlong-title"
        elif ((.detail? // "" | length) > 600) then "overlong-detail"
        elif ((.signature? // "" | length) > 200) then "overlong-signature"
        elif ((.fixVsBug? // "" | length) > 40) then "overlong-fixvsbug"
        elif (has("bucket") and ((.bucket) as $b
              | (["easy-fix","selector","vrt","app-change","infra","likely-bug"] | index($b) | not))) then "bad-bucket"
        elif (has("tier") and ((.tier|tostring) as $t | ($t | fullmatch("'"$TIER_RE"'") | not))) then "bad-tier"
        elif (has("passes") and has("runs") and (.passes > .runs)) then "passes>runs"
        elif ((.tests? // []) | any(.[]; ((.fqcn? // "") | fullmatch("'"$FQCN_RE"'") | not))) then "bad-fqcn"
        elif ((.tests? // []) | any(.[]; has("status") and ((.status) as $ts | (["red","green","skipped"] | index($ts) | not)))) then "bad-test-status"
        elif ((.tests? // []) | any(.[]; has("vrt") and ((.vrt) as $v | (($v|fullmatch("'"$VRT_RE"'"))|not)))) then "bad-vrt"
        else null end;
      ( [ .clusters[] as $c | ($c|reason) as $r | select($r != null) | {id: ($c.id? // "?"), reason: $r} ] )
      + ( [.clusters[] | .id? // "?"] | group_by(.) | map(select(length>1) | {id: .[0], reason: "dup-id"}) )
    ' "$FILE" 2>/dev/null)" || die "validate: unreadable/malformed ledger"
    [ "$BAD_JSON" = "[]" ] || die "schema violations: $BAD_JSON"
    if [ "$MODE" = "--final" ]; then
      OPEN="$(jq -r '[.clusters[] | select(.status=="selected" or .status=="applied") | .id] | join(",")' "$FILE" 2>/dev/null)" \
        || die "validate: unreadable/malformed ledger"
      [ -z "$OPEN" ] || { echo "ledger: NOT FINAL — non-terminal selected/applied clusters: $OPEN" >&2; exit 67; }
    fi
    echo "ledger: valid${MODE:+ ($MODE)}" >&2 ;;

  *) echo "ledger: unknown cmd '$CMD'" >&2; exit 64 ;;
esac
# I5 reminder: before apply, check the fix's presence in CURRENT source — not this ledger. P7: integrity/locking for shared use.
