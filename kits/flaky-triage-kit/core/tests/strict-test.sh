#!/bin/bash
# core/tests/strict-test.sh — Round3 (grep-newline anchor-asymmetry) test suite for core/_strict.sh
# and its 4 real call sites (ingest.sh / rerun.sh / dom-capture.sh / dom-on-failure.sh). Plain bash
# asserts, no framework (mirrors apply-test.sh / ledger-test.sh's style).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$HERE/.."
. "$CORE/_strict.sh"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

# the audit's exact bypass shape: a legit-looking first line, then an embedded newline followed by
# metacharacters/command-substitution-looking text. Built via `printf` on a SINGLE-QUOTED format
# string so bash never expands the `$(...)` — it's literal bytes simulating an injected payload,
# never actually executed here or by the scripts under test (their checks reject it before any
# eval'able context is reached).
mal() { printf '%s\n%s' "$1" "$2"; }  # $1=legit-looking first line  $2=malicious tail

# ============================================================================
# Part 1 — RED proof: reproduce the pre-fix grep validator's bypass in isolation
# (documents the vulnerability class this suite closes; does not touch the real scripts).
# ============================================================================
echo "== Part 1: RED proof — old grep -qE '^...$' validator is LINE-oriented, not string-oriented =="
old_grep_check() { printf '%s' "$1" | grep -qE '^[0-9A-Za-z._:+-]+$'; }
BAD_BUILD="$(mal "ok123" '$(touch /tmp/hektor-strict-test-pwned)')"
old_grep_check "$BAD_BUILD"
if [ $? -eq 0 ]; then ok; else bad "pre-fix grep validator's bypass reproduced (expected rc=0/BYPASSED on the multi-line value; this is the bug strict_match closes)"; fi
[ ! -e /tmp/hektor-strict-test-pwned ] && ok || { bad "sanity: no file was ever actually created by the literal payload text"; rm -f /tmp/hektor-strict-test-pwned; }

# ============================================================================
# Part 2 — strict_match unit tests: the 4 real ERE shapes, embedded-newline rejected, legit passes.
# ============================================================================
echo "== Part 2: strict_match unit tests (4 real ERE shapes) =="

# (a) ingest.sh build-name shape
BUILD_ERE='[0-9A-Za-z._:+-]+'
strict_match "release-1.2.3_build:42" "$BUILD_ERE" && ok || bad "build-name: legit value with no newline passes"
strict_match "$(mal "ok123" '$(touch /tmp/hektor-strict-test-pwned)')" "$BUILD_ERE" && bad "build-name: embedded-newline bypass NOT closed" || ok
[ ! -e /tmp/hektor-strict-test-pwned ] || { bad "build-name: literal payload should never execute"; rm -f /tmp/hektor-strict-test-pwned; }

# (b) rerun.sh FQCN-CSV shape
FQCN_CSV_ERE='[A-Za-z0-9_.,]+'
strict_match "com.x.FooTest,com.x.BarTest" "$FQCN_CSV_ERE" && ok || bad "fqcn-csv: legit value with no newline passes"
strict_match "$(mal "com.x.FooTest" 'rm -rf /')" "$FQCN_CSV_ERE" && bad "fqcn-csv: embedded-newline bypass NOT closed" || ok

# (c) dom-capture.sh URL shape
URL_ERE='https?://[A-Za-z0-9._~:/?#@%&=+-]+'
strict_match "https://www.example.com/otomobil?x=1" "$URL_ERE" && ok || bad "url: legit value with no newline passes"
strict_match "$(mal "https://www.example.com" '$(touch /tmp/hektor-strict-test-pwned)')" "$URL_ERE" && bad "url: embedded-newline bypass NOT closed" || ok
[ ! -e /tmp/hektor-strict-test-pwned ] || { bad "url: literal payload should never execute"; rm -f /tmp/hektor-strict-test-pwned; }

# (d) dom-on-failure.sh FQCN shape
FQCN_ERE='[A-Za-z0-9_.]+'
strict_match "com.x.FooTest.methodName" "$FQCN_ERE" && ok || bad "fqcn: legit value with no newline passes"
strict_match "$(mal "com.x.FooTest" '$(id)')" "$FQCN_ERE" && bad "fqcn: embedded-newline bypass NOT closed" || ok

# extra controls: value containing ONLY a newline, and a value that legitimately fails the shape
# (no newline involved) must still be rejected on shape grounds alone.
strict_match "$(printf '\n')" "$BUILD_ERE" && bad "a bare newline must never match" || ok
strict_match "bad value with spaces" "$BUILD_ERE" && bad "a shape violation with NO newline is still rejected" || ok

# ============================================================================
# Part 3 — integration: the 4 REAL scripts now reject embedded-newline input end-to-end.
# ============================================================================
echo "== Part 3: real validators (ingest.sh / rerun.sh / dom-capture.sh / dom-on-failure.sh) =="

# --- ingest.sh: the audit's exact repro — fullTestBuildName=ok123%0A<payload> on an allowlisted host.
#     The build-name check fires BEFORE any network call, so this is safe to run with no ES reachable.
ALLOWED_HOST="$(jq -r '.es.host_allowlist[0]' "$CORE/config.json")"
ENC_BUILD="$(mal "ok123" '$(touch /tmp/hektor-strict-test-pwned)' | python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.stdin.read(), safe=""))')"
URL="$ALLOWED_HOST/report?fullTestBuildName=${ENC_BUILD}&buildStartTime=1700000000000"
OUT_I="$("$CORE/ingest.sh" "$URL" 2>&1)"; RC_I=$?
[ "$RC_I" -eq 77 ] && ok || bad "ingest.sh rejects embedded-newline build name with exit 77 (got $RC_I: $OUT_I)"
echo "$OUT_I" | grep -q 'suspicious build name rejected' && ok || bad "ingest.sh error message identifies the build-name check"
[ ! -e /tmp/hektor-strict-test-pwned ] || { bad "ingest.sh: literal payload should never execute"; rm -f /tmp/hektor-strict-test-pwned; }
# (a clean-build-name "still accepted" control is covered offline by the strict_match unit test
# above — ingest.sh itself makes a real ES network call past this point, so it's deliberately not
# exercised here to keep this suite network-independent, like its sibling suites.)

# --- rerun.sh: RERUN_DRY isn't reached — the FQCN-CSV check fires before any gradle/Selenoid I/O.
BAD_TESTS="$(mal "com.x.FooTest" 'rm -rf /')"
OUT_R="$("$CORE/rerun.sh" "$BAD_TESTS" "128" 2>&1)"; RC_R=$?
[ "$RC_R" -eq 77 ] && ok || bad "rerun.sh rejects embedded-newline FQCN-CSV with exit 77 (got $RC_R: $OUT_R)"
echo "$OUT_R" | grep -q 'bad FQCN list rejected' && ok || bad "rerun.sh error message identifies the FQCN-CSV check"

GOOD_TESTS="com.x.FooTest,com.x.BarTest"
OUT_RG="$(RERUN_DRY=1 "$CORE/rerun.sh" "$GOOD_TESTS" "128" 2>&1)"; RC_RG=$?
[ "$RC_RG" -eq 0 ] && ok || bad "rerun.sh control: a clean FQCN-CSV is NOT rejected by the shape check (got $RC_RG: $OUT_RG)"

# --- dom-capture.sh: URL check fires before REPO/gradle resolution.
BAD_URL="$(mal "https://www.example.com" '$(touch /tmp/hektor-strict-test-pwned)')"
OUT_D="$("$CORE/dom-capture.sh" "$BAD_URL" "128" 2>&1)"; RC_D=$?
[ "$RC_D" -eq 77 ] && ok || bad "dom-capture.sh rejects embedded-newline url with exit 77 (got $RC_D: $OUT_D)"
echo "$OUT_D" | grep -q 'suspicious url rejected' && ok || bad "dom-capture.sh error message identifies the url check"
[ ! -e /tmp/hektor-strict-test-pwned ] || { bad "dom-capture.sh: literal payload should never execute"; rm -f /tmp/hektor-strict-test-pwned; }

OUT_DG="$(DOMCAP_DRY=1 "$CORE/dom-capture.sh" "https://www.example.com/otomobil" "128" 2>&1)"; RC_DG=$?
[ "$RC_DG" -eq 0 ] && ok || bad "dom-capture.sh control: a clean url is NOT rejected by the shape check (got $RC_DG: $OUT_DG)"

# --- dom-on-failure.sh: FQCN check fires before REPO/gradle resolution.
BAD_FQCN="$(mal "com.x.FooTest" '$(id)')"
OUT_F="$("$CORE/dom-on-failure.sh" "$BAD_FQCN" "128" 2>&1)"; RC_F=$?
[ "$RC_F" -eq 77 ] && ok || bad "dom-on-failure.sh rejects embedded-newline fqcn with exit 77 (got $RC_F: $OUT_F)"
echo "$OUT_F" | grep -q 'bad fqcn rejected' && ok || bad "dom-on-failure.sh error message identifies the fqcn check"

OUT_FG="$(DOMFAIL_DRY=1 "$CORE/dom-on-failure.sh" "com.x.FooTest.methodName" "128" 2>&1)"; RC_FG=$?
[ "$RC_FG" -eq 0 ] && ok || bad "dom-on-failure.sh control: a clean fqcn is NOT rejected by the shape check (got $RC_FG: $OUT_FG)"

echo "strict-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
