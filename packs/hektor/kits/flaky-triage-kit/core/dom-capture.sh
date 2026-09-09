#!/bin/bash
# core/dom-capture.sh — dump the RENDERED DOM of a page on the testbox (to author selector fixes).
#
# WHY (kernel N2): curl returns a login/skeleton — the search filter panel is JS-/session-rendered, so a
# selector-break fix can't be authored from the real DOM with curl. This drives the framework's browser on
# the tb (via Selenoid) and returns getPageSource() — the same DOM the tests see — by selecting the kit's
# own PageDomCaptureTest by name and passing the target via -Ddump.url (build forwards all -D to the test JVM).
#
# Contract: $1=url  $2=tb  →  rendered page source (stdout).  ($3=css-scope reserved; scope skill-side for now.)
# USAGE: $1 is the REAL site URL (e.g. https://www.sahibinden.com/otomobil), NOT the xtbx host — the framework
#        routes it to the reserved tb via -Dui.testbox, same as every test's BaseUrls navigation. PROVEN tb128.
# Enforces: I1 (validate url+tb; no shell/gradle-arg metacharacters) · reuses run.* config (same plumbing as rerun)
# Modes: DOMCAP_DRY=1 (print the gradle cmd, don't run).  Output file is LOCAL-TRANSIENT — never ship (I7).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; CFG="$HERE/config.json"
. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76
. "$HERE/_lock.sh"   # A (N6): serialize gradle on this working copy
. "$HERE/_strict.sh"   # Round3: shared whole-string shape matcher (closes the grep-newline anchor bypass)
for t in jq git; do command -v "$t" >/dev/null || { echo "dom-capture: $t required" >&2; exit 69; }; done

URL="${1:-}"; TB="${2:-}"
[ -n "$URL" ] && [ -n "$TB" ] || { echo "usage: dom-capture.sh <url> <tb>" >&2; exit 64; }
TB_RAW="$TB"   # kept for assert_tb_dc below: the data centre lives in the SPELLING, not in $TB
TBN="$(normalize_tb "$TB")" || { echo "I1: tb must be a testbox id (161, tb161, tbx161 or xtbx161): $TB" >&2; exit 77; }
TB="$TBN"
# I1: url must be a clean http(s) URL — no spaces / shell / gradle-arg metacharacters (this drives a
# real browser). strict_match (Round3) is WHOLE-STRING — an embedded-newline url that a line-oriented
# `grep -qE '^...$'` would have let through on its first line is correctly rejected here.
strict_match "$URL" 'https?://[A-Za-z0-9._~:/?#@%&=+-]+' \
  || { echo "I1: suspicious url rejected (must be a clean http(s) URL): $URL" >&2; exit 77; }

REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
WD="$(jq -r '.run.workdir' "$CFG")"
JH="${HEKTOR_FK_JAVA_HOME:-$(jq -r '.run.java_home // empty' "$CFG")}"; JH="${JH:-${JAVA_HOME:-}}"
{ [ -n "$JH" ] && [ -d "$JH" ]; } || echo "dom-capture: WARN JAVA_HOME unresolved ('$JH') — set HEKTOR_FK_JAVA_HOME (toolchain needs JDK 17)" >&2
PROF="$(jq -r '.run.profile' "$CFG")"; LP="$(jq -r '.run.launchpad' "$CFG")"
# HEKTOR_FK_DATA_CENTER honoured here as config.json's `_portability` note already promises and
# rerun.sh already did — without it, assert_tb_dc below would accept a box in rerun.sh and refuse
# the same box here the moment an operator used the documented override.
DC="${HEKTOR_FK_DATA_CENTER:-$(jq -r '.run.data_center' "$CFG")}"; BR="$(jq -r '.run.browser' "$CFG")"
# -Dapi.url is composed from $DC, never from the spelling — refuse a disagreement, never re-aim.
assert_tb_dc "$TB_RAW" "$DC" || exit 77
FQCN="$(jq -r '.dom_capture.test_fqcn' "$CFG")"; METH="$(jq -r '.dom_capture.method' "$CFG")"
[ -n "$FQCN" ] && [ "$FQCN" != "null" ] || { echo "dom-capture: config.dom_capture.test_fqcn missing" >&2; exit 78; }
# kit-local: the test lives in the KIT and is sourced into gradle via an init script (never in the suite tree)
INIT="$HERE/capture.init.gradle"; SRC="$HERE/capture-src"
{ [ -f "$INIT" ] && [ -d "$SRC" ]; } || { echo "dom-capture: kit capture sources missing ($INIT / $SRC)" >&2; exit 78; }

# N4: local-transient artifacts under the shared base; never ship (I7). Self-GC stale captures (>1 day) so a
# standalone dom-capture (no rerun in the loop to sweep) doesn't leave session-token/PII-bearing DOM behind.
BASE="${TMPDIR:-/tmp}/hektor-flaky-rerun"; mkdir -p "$BASE"
find "$BASE" -maxdepth 1 -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true   # GC captures/logdirs >1 day
# NOTE: XXXXXX must be TRAILING — BSD/macOS mktemp rejects a suffix after it (a non-trailing template
# yields an empty path and silently breaks the run). Portable on both BSD and GNU mktemp.
OUT="$(mktemp "$BASE/domcap.tb${TB}.XXXXXX")"
LOG="$(mktemp "$BASE/domcap.tb${TB}.log.XXXXXX")"
[ -n "$OUT" ] && [ -n "$LOG" ] || { echo "dom-capture: mktemp failed (empty temp path)" >&2; exit 73; }

# `cleanTest test`, NOT `--rerun-tasks` — the same trap rerun.sh documents.
# `--rerun-tasks` also re-runs :generate-method-plugin:instrumentCode, which is
# in gradle_excludes, so the classes are rebuilt WITHOUT their @GenerateMethods
# methods and the -Dtests-named method is no longer discovered.
cmd=(env "JAVA_HOME=$JH" "$REPO/$WD/gradlew" -p "$REPO/$WD" cleanTest test --no-build-cache
     "--init-script" "$INIT" "-Ddomcap.srcDir=$SRC"
     "-Dtests=${FQCN}.${METH}" "-Ddump.url=${URL}" "-Ddump.output=${OUT}"
     "-Dspring.profiles.active=$PROF" "-Denv.launchpad=$LP" "-Denv.data.center=$DC"
     # -Dapi.url is MANDATORY: client.properties has no default for it
     # (`api.url=${sys:api.url}`), so without it the Spring context never loads
     # and every test reports FAILED with UnknownHostException — an environment
     # failure the gate would otherwise grade as a real red verdict.
     # Format per web-test/CLAUDE.md: <dc>tb<dc><id>.
     "-Dapi.url=${API_URL:-${DC}tb${DC}${TB}}"
     "-Dui.testbox=$TB" "-Dui.browser.type=$BR" "--console=plain")
while IFS= read -r e; do cmd+=("-x" "$e"); done < <(jq -r '.run.gradle_excludes[]' "$CFG")

if [ "${DOMCAP_DRY:-0}" = "1" ]; then printf 'DRY-RUN:\n'; printf '%q ' "${cmd[@]}"; echo; echo "OUT=$OUT"; exit 0; fi

echo "dom-capture: navigating tb$TB -> $URL via Selenoid (slow)…" >&2
gradle_lock_acquire "$REPO/$WD"   # A: don't collide with a concurrent gradle run
"${cmd[@]}" > "$LOG" 2>&1 || true

if [ -s "$OUT" ]; then
  cat "$OUT"
  echo "dom-capture: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes) — LOCAL-TRANSIENT, do not ship (I7)" >&2
  exit 0
fi
# no output file -> try the stdout-sentinel fallback, else diagnose
if grep -q 'DOM-CAPTURE-BEGIN' "$LOG"; then
  sed -n '/^DOM-CAPTURE-BEGIN$/,/^DOM-CAPTURE-END$/p' "$LOG" | sed '1d;$d'
  exit 0
fi
echo "dom-capture: NO DOM captured — the test was SKIPPED (no -Ddump.url reached the JVM) or the run failed/didn't run (N1)." >&2
echo "dom-capture: signal lines from $LOG:" >&2
grep -iE 'SKIPPED|FAILED|BUILD (SUCC|FAIL)|No tests|Assumption|DOM-CAPTURE' "$LOG" | tail -8 >&2 || true
exit 1
