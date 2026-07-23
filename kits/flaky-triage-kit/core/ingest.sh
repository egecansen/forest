#!/bin/bash
# core/ingest.sh — pin the build + pull its FAILED docs from the s-report (ES).
#
# Enforces: I1 (sanitize + es.host_allowlist) · pin-by-@timestamp (anti-stale-build)
# Contract:  $1 = report URL  →  stdout JSON { build:{name,startMs,docTs,failCount}, fails:[docs] }
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$HERE/config.json"
. "$HERE/_strict.sh"   # Round3: shared whole-string shape matcher (closes the grep-newline anchor bypass)
for t in jq curl; do command -v "$t" >/dev/null || { echo "ingest: $t required" >&2; exit 69; }; done

# P1: strip ASCII-smuggling / invisible / bidi codepoints AND ANSI/control-char smuggling from the
# UNTRUSTED report text before it reaches the model (all external text is DATA, never instructions).
# Fail-open if python3/helper absent — ingest must not hard-fail over a broken install — but Round3:
# warn loudly on stderr when that happens, so a broken/missing sanitizer is OBSERVABLE instead of
# silently dropping ALL smuggling defense on unsanitized stackTrace/testName/jiraTicket text.
sanitize() {
  if command -v python3 >/dev/null 2>&1 && [ -f "$HERE/sanitize-text.py" ]; then
    python3 "$HERE/sanitize-text.py"
  else
    echo "ingest: WARNING — python3/sanitize-text.py unavailable; smuggling defense (P1/I1) is DISABLED for this run (fail-open, output NOT sanitized)" >&2
    cat
  fi
}

URL="${1:-}"
[ -n "$URL" ] || { echo "usage: ingest.sh <s-report-url>" >&2; exit 64; }

# --- I1: host must be allowlisted ---
host="$(printf '%s' "$URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
jq -e --arg h "$host" '.es.host_allowlist | index($h)' "$CFG" >/dev/null \
  || { echo "I1: report host not in es.host_allowlist: $host" >&2; exit 77; }

# --- parse query string: fullTestBuildName + buildStartTime (URL-decode, pure bash) ---
urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }
qs="${URL#*\?}"
build="$(urldecode "$(printf '%s' "$qs" | tr '&' '\n' | sed -n 's/^fullTestBuildName=//p' | head -1)")"
startMs="$(printf '%s' "$qs" | tr '&' '\n' | sed -n 's/^buildStartTime=//p' | head -1)"
# I1 (V-1): startMs feeds bash arithmetic ($((startMs/1000)) below) — arith-eval recursively
# evaluates a non-numeric string as code (e.g. HOME[$(cmd)]) → RCE from an untrusted report URL.
# set -uo pipefail does NOT stop it; reject anything but digits before it reaches $(( )).
[ -z "$startMs" ] || printf '%s' "$startMs" | grep -qE '^[0-9]+$' \
  || { echo "I1: non-numeric buildStartTime rejected: $startMs" >&2; exit 77; }
[ -n "$build" ] || { echo "ingest: no fullTestBuildName in URL" >&2; exit 64; }
# I1: build-name shape sanity (no shell/ES metacharacters). strict_match (Round3) is WHOLE-STRING —
# unlike `grep -qE '^...$'` (line-oriented: matches if ANY line of a multi-line value matches), an
# embedded-newline build name (e.g. "ok123\n$(payload)") is correctly rejected here.
strict_match "$build" '[0-9A-Za-z._:+-]+' \
  || { echo "I1: suspicious build name rejected: $build" >&2; exit 77; }

ES="$(jq -r '.es.host + .es.endpoint' "$CFG")"

# --- pull FAILED docs for this exact build (incl. @timestamp for the stale guard) ---
body="$(jq -n --arg b "$build" '{
  size:500,
  _source:["testName","testPath","testKure","testTags","testbox","stackTrace","@timestamp","jiraTicket"],
  query:{bool:{must:[
    {term:{"testBuildName.keyword":$b}},
    {term:{"testStatus.keyword":"FAILED"}}]}}}')"
resp="$(curl -sk -m 30 -X POST "$ES" -H 'Content-Type: application/json' -d "$body")" \
  || { echo "ingest: ES query failed" >&2; exit 69; }
echo "$resp" | jq -e '.hits' >/dev/null 2>&1 || { echo "ingest: bad ES response" >&2; exit 69; }

# --- G-1 (I6/V7): `size` caps returned hits; if the build has MORE fails than we pulled,
#     whole clusters silently vanish. Read hits.total (ES7 {value} or legacy number) and warn LOUDLY. ---
total="$(echo "$resp" | jq -r '.hits.total | if type=="object" then (.value//0) else (.//0) end')"
returned="$(echo "$resp" | jq -r '.hits.hits|length')"
if [ "${total:-0}" -gt "${returned:-0}" ] 2>/dev/null; then
  echo "ingest: TRUNCATION WARNING — build has $total FAILED docs but only $returned returned (size cap); $((total-returned)) DROPPED. Clusters are INCOMPLETE — narrow the build or raise es size." >&2
fi

# --- anti-stale guard (pin-by-@timestamp): warn if docs predate buildStartTime ---
docMin="$(echo "$resp" | jq -r '[.hits.hits[]._source["@timestamp"]] | min // empty')"
if [ -n "$startMs" ] && [ -n "$docMin" ]; then
  syear="$(date -r "$((startMs/1000))" +%Y 2>/dev/null || echo '?')"
  [ "$syear" = "${docMin:0:4}" ] \
    || echo "ingest: STALE-BUILD WARNING — buildStartTime year=$syear but docs year=${docMin:0:4} (build-number reuse?); verify the pinned run." >&2
fi

# C (N6): which failing tests' source is modified in the working tree (phantom "already-fixed" guard)
REPO="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || true)"
mods='[]'
if [ -n "$REPO" ]; then
  mods="$(git -C "$REPO" diff --name-only HEAD 2>/dev/null | grep -E '\.java$' | sed -E 's#.*/##; s#\.java$##' | jq -R . | jq -s 'unique')"
  [ -n "$mods" ] || mods='[]'
fi

# D (N6): surface the VRT comparison URL for VRT fails so the table can link it (baseline-vs-regression in one click)
echo "$resp" | jq --arg b "$build" --arg s "${startMs:-}" --argjson mods "$mods" \
  'def total: (.hits.total | if type=="object" then (.value//0) else (.//0) end);
   {build:{name:$b, startMs:$s,
           jiraTicket:([.hits.hits[]._source.jiraTicket]|map(select(.!=null and .!=""))|.[0] // null),
           docTs:{min:([.hits.hits[]._source["@timestamp"]]|min), max:([.hits.hits[]._source["@timestamp"]]|max)},
           failCount:(.hits.hits|length),
           failTotal:total,
           truncated:(total > (.hits.hits|length))},
    fails:[.hits.hits[]._source | (.testName | split(".")[0]) as $cls | . + {
      vrt_url: ((.stackTrace // "") | [match("https://vrt-\\S+").string] | (.[0] // null)),
      working_tree_modified: ($mods | any(. == $cls))
    }]}' | sanitize
