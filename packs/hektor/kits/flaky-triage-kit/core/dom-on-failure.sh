#!/bin/bash
# core/dom-on-failure.sh — run a FAILING test on the tb and dump its rendered DOM AT THE FAILURE POINT.
#
# WHY (kernel N2 — the dom-capture limitation): selector breaks on flow-gated pages (payment widget,
# classified-posting form, flag-enabled detail) can't be reached by single-URL dom-capture. This runs the
# actual test (which drives the full flow) with the kit's DomDumpOnFailure extension auto-registered, so on
# failure it writes getPageSource() — letting the fix be authored from the real DOM at the exact failure state.
#
# Contract: $1=test-fqcn(.method)  $2=tb  ->  dumped DOM file path(s) on stdout (sizes/log on stderr).
# Reuses run.* config + capture.init.gradle (sources the extension + its META-INF/services file).
# Modes: DOMFAIL_DRY=1 (print the gradle cmd). Output dir is LOCAL-TRANSIENT — never ship (I7).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; CFG="$HERE/config.json"
. "$HERE/_integrity.sh"; integrity_guard "$HERE/.." || exit 76
. "$HERE/_lock.sh"   # A (N6): serialize gradle on this working copy
. "$HERE/_strict.sh"   # Round3: shared whole-string shape matcher (closes the grep-newline anchor bypass)
for t in jq git; do command -v "$t" >/dev/null || { echo "dom-on-failure: $t required" >&2; exit 69; }; done

FQCN="${1:-}"; TB="${2:-}"
[ -n "$FQCN" ] && [ -n "$TB" ] || { echo "usage: dom-on-failure.sh <test-fqcn[.method]> <tb>" >&2; exit 64; }
TBN="$(normalize_tb "$TB")" || { echo "I1: tb must be a testbox id (161 or tb161): $TB" >&2; exit 77; }
TB="$TBN"
# Round3: strict_match is WHOLE-STRING — an embedded-newline fqcn that a line-oriented `grep -qE
# '^...$'` would have let through on its first line is correctly rejected here.
strict_match "$FQCN" '[A-Za-z0-9_.]+' || { echo "I1: bad fqcn rejected: $FQCN" >&2; exit 77; }

REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
WD="$(jq -r '.run.workdir' "$CFG")"
JH="${HEKTOR_FK_JAVA_HOME:-$(jq -r '.run.java_home // empty' "$CFG")}"; JH="${JH:-${JAVA_HOME:-}}"
PROF="$(jq -r '.run.profile' "$CFG")"; LP="$(jq -r '.run.launchpad' "$CFG")"
DC="$(jq -r '.run.data_center' "$CFG")"; BR="$(jq -r '.run.browser' "$CFG")"
INIT="$HERE/capture.init.gradle"; SRC="$HERE/capture-src"; RES="$HERE/capture-res"
{ [ -f "$INIT" ] && [ -d "$SRC" ] && [ -d "$RES" ]; } || { echo "dom-on-failure: kit capture sources missing" >&2; exit 78; }

BASE="${TMPDIR:-/tmp}/hektor-flaky-rerun"; mkdir -p "$BASE"
find "$BASE" -maxdepth 1 -mindepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
FAILDIR="$(mktemp -d "$BASE/domfail.tb${TB}.XXXXXX")"

# `cleanTest test`, NOT `--rerun-tasks` — the same trap rerun.sh documents.
# `--rerun-tasks` also re-runs :generate-method-plugin:instrumentCode, which is
# in gradle_excludes, so the classes are rebuilt WITHOUT their @GenerateMethods
# methods and the -Dtests-named method is no longer discovered.
cmd=(env "JAVA_HOME=$JH" "$REPO/$WD/gradlew" -p "$REPO/$WD" cleanTest test --no-build-cache
     "--init-script" "$INIT" "-Ddomcap.srcDir=$SRC" "-Ddomcap.resDir=$RES"
     "-Djunit.jupiter.extensions.autodetection.enabled=true" "-Ddump.failDir=$FAILDIR"
     "-Dtests=$FQCN" "-Dspring.profiles.active=$PROF" "-Denv.launchpad=$LP" "-Denv.data.center=$DC"
     # -Dapi.url is MANDATORY: client.properties has no default for it
     # (`api.url=${sys:api.url}`), so without it the Spring context never loads
     # and every test reports FAILED with UnknownHostException — an environment
     # failure the gate would otherwise grade as a real red verdict.
     # Format per web-test/CLAUDE.md: <dc>tb<dc><id>.
     "-Dapi.url=${API_URL:-${DC}tb${DC}${TB}}"
     "-Dui.testbox=$TB" "-Dui.browser.type=$BR" "--console=plain")
while IFS= read -r e; do cmd+=("-x" "$e"); done < <(jq -r '.run.gradle_excludes[]' "$CFG")

if [ "${DOMFAIL_DRY:-0}" = "1" ]; then printf '%q ' "${cmd[@]}"; echo; echo "FAILDIR=$FAILDIR"; exit 0; fi

echo "dom-on-failure: running $FQCN on tb$TB; DOM dumps to $FAILDIR on failure (slow)…" >&2
gradle_lock_acquire "$REPO/$WD"   # A: don't collide with a concurrent gradle run
"${cmd[@]}" > "$FAILDIR/run.log" 2>&1 || true

n=$(find "$FAILDIR" -name '*.html' 2>/dev/null | wc -l | tr -d ' ')
if [ "$n" -gt 0 ]; then
  echo "dom-on-failure: dumped $n DOM file(s) — LOCAL-TRANSIENT, do not ship (I7):" >&2
  find "$FAILDIR" -name '*.html' 2>/dev/null -exec sh -c 'echo "  $1 ($(wc -c <"$1"|tr -d " ") bytes)" >&2' _ {} \;
  find "$FAILDIR" -name '*.html' 2>/dev/null
  exit 0
fi
# Distinguish "nothing ran" from "the test passed" — reporting a run that
# never executed as a pass is the wrong-verdict shape this kit exists to avoid.
if grep -qiE 'No tests were executed|NO-SOURCE' "$FAILDIR/run.log" 2>/dev/null; then
  echo "dom-on-failure: NO TESTS EXECUTED — the run never happened, this is not a pass. See $FAILDIR/run.log." >&2
  grep -iE 'No tests|BUILD (SUCC|FAIL)' "$FAILDIR/run.log" 2>/dev/null | tail -8 >&2 || true
  exit 66
fi
echo "dom-on-failure: NO DOM dumped — test PASSED, or the driver was gone at failure (check the hook timing)." >&2
grep -iE 'DOM-DUMP-ON-FAIL|> .*\(\) (PASSED|FAILED)|BUILD (SUCC|FAIL)|No tests' "$FAILDIR/run.log" 2>/dev/null | tail -8 >&2 || true
exit 1
