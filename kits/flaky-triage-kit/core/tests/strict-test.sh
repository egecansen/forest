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

# --- normalize_tb: one testbox, either spelling, at every entry point.
# The kit used to demand `161` here while accepting `tb161` at ingest, so a driver that carried
# the console's own spelling through got exit 77 from the next call with nothing explaining why.
[ "$(normalize_tb 161)"   = "161" ] && ok || bad "normalize_tb keeps a bare numeric id"
[ "$(normalize_tb tb161)" = "161" ] && ok || bad "normalize_tb strips the tb prefix"
[ "$(normalize_tb TB161)" = "161" ] && ok || bad "normalize_tb strips an uppercase TB prefix"
normalize_tb ""        >/dev/null 2>&1 && bad "normalize_tb must reject an empty value"   || ok
normalize_tb "tb"      >/dev/null 2>&1 && bad "normalize_tb must reject a bare prefix"    || ok
normalize_tb "16a"     >/dev/null 2>&1 && bad "normalize_tb must reject a non-numeric id" || ok
normalize_tb "tb161x"  >/dev/null 2>&1 && bad "normalize_tb must reject trailing junk"    || ok
normalize_tb '161; id' >/dev/null 2>&1 && bad "normalize_tb must reject a shell metachar" || ok
# The grep-newline hole this whole file exists for: line 1 is digits, the value is not.
normalize_tb "$(mal 161 '$(id)')" >/dev/null 2>&1 \
  && bad "normalize_tb must reject an embedded-newline value whose first line is numeric" || ok

# ...and the three CLIs that carried the raw grep check on tb must now reject it the same way.
"$CORE/rerun.sh" "com.x.FooTest" "$(mal 161 '$(id)')" >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "rerun.sh must reject an embedded-newline testbox with exit 77"
"$CORE/dom-capture.sh" "https://www.sahibinden.com/otomobil" "$(mal 161 '$(id)')" >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "dom-capture.sh must reject an embedded-newline testbox with exit 77"
"$CORE/dom-on-failure.sh" "com.x.FooTest.m" "$(mal 161 '$(id)')" >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "dom-on-failure.sh must reject an embedded-newline testbox with exit 77"

# The prefixed spelling must reach gradle as the BARE id — `-Dapi.url` composes its own `tb`, so a
# pass-through would build `tbtb161` and route the run at nothing.
OUT_TB="$(RERUN_DRY=1 "$CORE/rerun.sh" "com.x.FooTest" "tb161" 2>&1)"
echo "$OUT_TB" | grep -q 'ui.testbox=161' && ok || bad "rerun.sh must pass the bare id to -Dui.testbox given tb161"
echo "$OUT_TB" | grep -q 'api.url=[^ ]*tbtb' && bad "rerun.sh must not double the tb prefix in -Dapi.url" || ok

# ============================================================================
# Part 4 — the data-centre spellings (2026-08-19).
#
# The round above taught the kit `tb`. It did NOT teach it the data-centre letter, so `tbx161` —
# the string hektor-orchestrator's own SKILL.md prints in its prompt, *"Which testbox? e.g.,
# `tbx161`"* — was stripped to `x161` and rejected. The skill layer and the engine disagreed about
# what a testbox looks like while the CHANGELOG claimed "a testbox is one thing again".
# ============================================================================
echo "== Part 4: data-centre spellings (tbx161 / xtbx161) =="

# --- the four spellings all name box 161.
[ "$(normalize_tb tbx161)"  = "161" ] && ok || bad "normalize_tb accepts tbx161 (orchestrator's own prompt string)"
[ "$(normalize_tb tby161)"  = "161" ] && ok || bad "normalize_tb accepts tby161 (the gcp data centre)"
[ "$(normalize_tb xtbx161)" = "161" ] && ok || bad "normalize_tb accepts xtbx161 (the URL host form)"
[ "$(normalize_tb ytby161)" = "161" ] && ok || bad "normalize_tb accepts ytby161"
[ "$(normalize_tb XTBX161)" = "161" ] && ok || bad "normalize_tb accepts the shouted spelling"

# --- and the letter must not become a licence to accept nonsense.
normalize_tb "xtby161" >/dev/null 2>&1 \
  && bad "normalize_tb must reject xtby161 — the URL form repeats ONE data centre, so xy is a typo" || ok
normalize_tb "x161"    >/dev/null 2>&1 && bad "normalize_tb must reject x161 — a letter with no tb to prefix"   || ok
normalize_tb "ztbz161" >/dev/null 2>&1 && bad "normalize_tb must reject an unknown data-centre letter"          || ok
normalize_tb "tbx"     >/dev/null 2>&1 && bad "normalize_tb must reject tbx — no id at all"                     || ok
normalize_tb "tbx16a"  >/dev/null 2>&1 && bad "normalize_tb must reject a non-numeric id behind the letter"     || ok
normalize_tb "$(mal xtbx161 '$(id)')" >/dev/null 2>&1 \
  && bad "normalize_tb must reject an embedded-newline value whose first line is a valid dc spelling" || ok

# --- normalize_tb_dc reports the letter the spelling carried, and only that.
[ "$(normalize_tb_dc 161)"     = ""  ] && ok || bad "normalize_tb_dc reports no data centre for a bare id"
[ "$(normalize_tb_dc tb161)"   = ""  ] && ok || bad "normalize_tb_dc reports no data centre for tb161"
[ "$(normalize_tb_dc tbx161)"  = "x" ] && ok || bad "normalize_tb_dc reports x for tbx161"
[ "$(normalize_tb_dc ytby161)" = "y" ] && ok || bad "normalize_tb_dc reports y for ytby161"
[ "$(normalize_tb_dc XTBX161)" = "x" ] && ok || bad "normalize_tb_dc lowercases the letter it reports"

# --- assert_tb_dc: silence when the spelling agrees or says nothing, refusal when it contradicts.
assert_tb_dc "161"     "x" 2>/dev/null && ok || bad "assert_tb_dc passes a spelling that names no data centre"
assert_tb_dc "tbx161"  "x" 2>/dev/null && ok || bad "assert_tb_dc passes a spelling that agrees with the kit"
assert_tb_dc "ytby161" "x" 2>/dev/null && bad "assert_tb_dc must refuse a spelling that contradicts the kit" || ok
assert_tb_dc "16a"     "x" 2>/dev/null && ok || bad "assert_tb_dc leaves an unparseable value to normalize_tb's own error"
MSG_DC="$(assert_tb_dc "ytby161" "x" 2>&1)"
echo "$MSG_DC" | grep -q "names data centre 'y'"  && ok || bad "assert_tb_dc's message names the data centre the operator asked for"
echo "$MSG_DC" | grep -q "HEKTOR_FK_DATA_CENTER=y" && ok || bad "assert_tb_dc's message says how to proceed"

# --- the regression that started this: tbx161 must reach gradle, not exit 77.
OUT_X="$(RERUN_DRY=1 "$CORE/rerun.sh" "com.x.FooTest" "tbx161" 2>&1)"; RC_X=$?
[ "$RC_X" -eq 0 ] && ok || bad "rerun.sh must ACCEPT tbx161 — orchestrator tells operators to type it (got $RC_X: $OUT_X)"
echo "$OUT_X" | grep -q 'ui.testbox=161'     && ok || bad "rerun.sh passes the bare id to -Dui.testbox given tbx161"
echo "$OUT_X" | grep -q 'api.url=[^ ]*xtbx161' && ok || bad "rerun.sh composes api.url as xtbx161 given tbx161"
echo "$OUT_X" | grep -q 'api.url=[^ ]*tbtb'   && bad "rerun.sh must not double the tb prefix given tbx161" || ok

# --- THE ONE THIS FIX EXISTS FOR: a contradicted data centre must never be silently re-aimed.
# Accepting ytby161 and handing back a bare 161 would compose xtbx161 from the kit's own $DC and
# run against a box in the wrong data centre without a word. Loud refusal is the required outcome.
OUT_Y="$(RERUN_DRY=1 "$CORE/rerun.sh" "com.x.FooTest" "ytby161" 2>&1)"; RC_Y=$?
[ "$RC_Y" -eq 77 ] && ok || bad "rerun.sh must refuse ytby161 while configured for x (got $RC_Y: $OUT_Y)"
# Assert it never reached the gradle line at all. Grepping the output for `xtbx` would be wrong:
# assert_tb_dc's message quotes the url it WOULD have built, which is exactly that string.
echo "$OUT_Y" | grep -q '\-Dapi\.url=' && bad "rerun.sh must refuse before composing any -Dapi.url for a contradicted box" || ok

# --- ...and the documented override is what unblocks it, in every script that takes a box.
OUT_YE="$(HEKTOR_FK_DATA_CENTER=y RERUN_DRY=1 "$CORE/rerun.sh" "com.x.FooTest" "ytby161" 2>&1)"; RC_YE=$?
[ "$RC_YE" -eq 0 ] && ok || bad "HEKTOR_FK_DATA_CENTER=y must let the y box through (got $RC_YE: $OUT_YE)"
echo "$OUT_YE" | grep -q 'api.url=[^ ]*ytby161' && ok || bad "rerun.sh composes api.url as ytby161 under the y override"

# dom-capture.sh and dom-on-failure.sh read run.data_center directly and ignored
# HEKTOR_FK_DATA_CENTER, which config.json's own `_portability` note promises is honoured. Left
# alone they would refuse the very box rerun.sh had just accepted under the override.
"$CORE/dom-capture.sh"    "https://www.sahibinden.com/otomobil" "ytby161" >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "dom-capture.sh must refuse a y box while configured for x"
"$CORE/dom-on-failure.sh" "com.x.FooTest.m" "ytby161" >/dev/null 2>&1
[ $? -eq 77 ] && ok || bad "dom-on-failure.sh must refuse a y box while configured for x"
OUT_DCE="$(HEKTOR_FK_DATA_CENTER=y "$CORE/dom-capture.sh" "https://www.sahibinden.com/otomobil" "ytby161" 2>&1)"
echo "$OUT_DCE" | grep -q 'names data centre' \
  && bad "dom-capture.sh must honour HEKTOR_FK_DATA_CENTER like rerun.sh does" || ok

echo "strict-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
