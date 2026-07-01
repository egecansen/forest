#!/bin/bash
# core/ledger.sh — run-state I/O (resumable, auditable).
#
# Enforces: I5 — callers re-derive "already applied" from SOURCE, never trust this ledger for a safety decision.
# Usage: ledger.sh init <file>
#        ledger.sh get  <file> [jq-path]
#        ledger.sh set  <file> '<jq-filter>' [--arg NAME VAL | --argjson NAME JSON]...
#          Bind UNTRUSTED values via --arg/--argjson so they reach jq as $NAME — never string-interpolate
#          attacker-influenced data (test names, stackTrace slices, ticket text) INTO the filter (jq-injection).
set -uo pipefail
command -v jq >/dev/null || { echo "ledger: jq required" >&2; exit 69; }
CMD="${1:-}"; FILE="${2:-}"
[ -n "$CMD" ] && [ -n "$FILE" ] || { echo "usage: ledger.sh init|get|set <file> [...]" >&2; exit 64; }

case "$CMD" in
  init) jq -n '{run:{}, clusters:[], events:[]}' > "$FILE"; echo "ledger: initialized $FILE" >&2 ;;
  get)  jq -r "${3:-.}" "$FILE" ;;
  set)  flt="${3:?ledger set: need a jq filter}"; shift 3   # remaining args = --arg/--argjson pairs forwarded to jq
        tmp="$(mktemp)"; jq "$@" "$flt" "$FILE" > "$tmp" && mv "$tmp" "$FILE" ;;
  *)    echo "ledger: unknown cmd '$CMD'" >&2; exit 64 ;;
esac
# I5 reminder: before apply, check the fix's presence in CURRENT source — not this ledger. P7: integrity/locking for shared use.
