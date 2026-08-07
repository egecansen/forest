#!/bin/bash
# core/tests/ingest-list-test.sh — ingest.sh's --testbox/--tests input mode (mode 2).
#
# The mode exists because a session given "testbox + test list" had no engine entry point and
# hand-rolled raw ES curls — bypassing the host allowlist, the build pin, and sanitize() (observed
# 2026-08-05). These tests pin the mode's contract: freshest-doc build resolution, list filtering,
# missing_requested reporting, and I1 shape rejection for every new input — including the
# ES-sourced build name, which is exactly as untrusted as a URL's.
#
# curl is PATH-shimmed (mirrors install-guard-test.sh's stat shim): the resolve query is told apart
# from the FAILED-docs query by the body's testStatus term, not by argument order or formatting.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INGEST="$HERE/../ingest.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

SHIM="$TMP/bin"; mkdir -p "$SHIM"
cat > "$SHIM/curl" <<'SH'
#!/bin/bash
body=""; prev=""
for a in "$@"; do [ "$prev" = "-d" ] && body="$a"; prev="$a"; done
case "$body" in
  *testStatus*) cat "$CURL_FAILS" ;;
  *)            cat "$CURL_RESOLVE" ;;
esac
SH
chmod +x "$SHIM/curl"
export CURL_RESOLVE="$TMP/resolve.json" CURL_FAILS="$TMP/fails.json"

cat > "$CURL_RESOLVE" <<'J'
{"hits":{"total":{"value":1},"hits":[{"_source":{"testBuildName":"web-2026.08.05-1_tb215","@timestamp":"2026-08-05T10:00:00Z"}}]}}
J
cat > "$CURL_FAILS" <<'J'
{"hits":{"total":{"value":3},"hits":[
 {"_source":{"testName":"BulkDopingTest.testGiftBulkDopingUsage","testbox":"tb215","stackTrace":"boom A","@timestamp":"2026-08-05T10:01:00Z"}},
 {"_source":{"testName":"HomePageTest.testHomePageIsInEnglish","testbox":"tb215","stackTrace":"boom B","@timestamp":"2026-08-05T10:02:00Z"}},
 {"_source":{"testName":"OtherTest.testUnrelated","testbox":"tb215","stackTrace":"boom C","@timestamp":"2026-08-05T10:03:00Z"}}]}}
J

# --- the happy path: resolve, pin, filter, report the ghost ---
OUT="$(PATH="$SHIM:$PATH" "$INGEST" --testbox tb215 \
  --tests "BulkDopingTest.testGiftBulkDopingUsage,HomePageTest.testHomePageIsInEnglish,GhostTest.testNeverRan" \
  2>"$TMP/err")"; RC=$?
[ "$RC" -eq 0 ] && ok || bad "list mode exits 0 (rc=$RC; stderr: $(tail -1 "$TMP/err"))"
[ "$(echo "$OUT" | jq -r '.build.name')" = "web-2026.08.05-1_tb215" ] && ok || bad "build pinned from the box's freshest doc"
[ "$(echo "$OUT" | jq -r '.fails | length')" = "2" ] && ok || bad "fails filtered to the requested list"
[ "$(echo "$OUT" | jq -r '.build.failCount')" = "2" ] && ok || bad "failCount matches the filtered set"
[ "$(echo "$OUT" | jq -r '.build.failCountBuildWide')" = "3" ] && ok || bad "build-wide count stays visible"
[ "$(echo "$OUT" | jq -r '.build.requested')" = "3" ] && ok || bad "requested count reported"
[ "$(echo "$OUT" | jq -r '.build.missing_requested | join(",")')" = "GhostTest.testNeverRan" ] \
  && ok || bad "a requested test with no FAILED doc in the pinned build is named, not silently dropped"
echo "$OUT" | jq -e '.fails[] | select(.testName=="OtherTest.testUnrelated")' >/dev/null 2>&1 \
  && bad "an unrequested test must be filtered out" || ok

# --- no --tests: the whole pinned build, and no list-mode keys invented ---
OUT2="$(PATH="$SHIM:$PATH" "$INGEST" --testbox tb215 2>/dev/null)"
[ "$(echo "$OUT2" | jq -r '.fails | length')" = "3" ] && ok || bad "no --tests → the whole pinned build"
[ "$(echo "$OUT2" | jq -r '.build | has("missing_requested")')" = "false" ] \
  && ok || bad "no --tests → no missing_requested key (the schema only grows when the mode is used)"

# --- I1: every new input is shape-checked before it reaches jq/ES ---
PATH="$SHIM:$PATH" "$INGEST" --testbox 'tb215;rm -rf x' >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "shell-metacharacter testbox rejected with 77"
PATH="$SHIM:$PATH" "$INGEST" --testbox tb215 --tests 'Cls.m,$(payload)' >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "suspicious test name rejected with 77"
PATH="$SHIM:$PATH" "$INGEST" --testbox tb215 --tests 'bareMethodNoDot' >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "dotless test name rejected with 77 (Class.method is the contract)"

# --- the ES-sourced build name is untrusted, exactly like a URL's ---
cat > "$CURL_RESOLVE" <<'J'
{"hits":{"hits":[{"_source":{"testBuildName":"evil`cmd`name","@timestamp":"2026-08-05T10:00:00Z"}}]}}
J
PATH="$SHIM:$PATH" "$INGEST" --testbox tb215 >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "a suspicious ES-resolved build name is rejected with 77"

# --- no docs for the box: a loud 69, not an empty pin ---
cat > "$CURL_RESOLVE" <<'J'
{"hits":{"total":{"value":0},"hits":[]}}
J
PATH="$SHIM:$PATH" "$INGEST" --testbox tb999 >/dev/null 2>&1
[ $? -eq 69 ] && ok || bad "an unknown testbox fails 69 with 'cannot resolve a build to pin'"

# --- mode 1 is untouched ---
"$INGEST" >/dev/null 2>&1
[ $? -eq 64 ] && ok || bad "no arguments still exits 64 with usage"
"$INGEST" 'https://evil.example.com/api/x?fullTestBuildName=b1' >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "URL mode still enforces the host allowlist (77)"

echo "ingest-list-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
