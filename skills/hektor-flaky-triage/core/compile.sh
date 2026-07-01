#!/bin/bash
# core/compile.sh — compile-check the test sources with the right JDK + excludes, no footguns.
#
# Why: after an `apply`, verify it compiles BEFORE a slow Selenoid green-proof. Hand-typing
# JAVA_HOME is the footgun (observed s4-flaky-1394: wrong path → a dead cycle). This resolves
# the JDK exactly like rerun.sh (run.java_home / HEKTOR_FK_JAVA_HOME / $JAVA_HOME), applies the
# same gradle_excludes, and serializes via the shared gradle lock.
# Contract: (no args) → compiles :compileTestJava → stdout JSON {ok, errors:[…first lines]} ; exit 0 ok / 1 fail
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; CFG="$HERE/config.json"
command -v jq >/dev/null || { echo "compile: jq required" >&2; exit 69; }
. "$HERE/_lock.sh"

REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
WD="$(jq -r '.run.workdir' "$CFG")"
JH="${HEKTOR_FK_JAVA_HOME:-$(jq -r '.run.java_home // empty' "$CFG")}"; JH="${JH:-${JAVA_HOME:-}}"
{ [ -n "$JH" ] && [ -d "$JH" ]; } || echo "compile: WARN JAVA_HOME unresolved ('$JH') — set run.java_home (toolchain needs JDK 17)" >&2

cmd=(env "JAVA_HOME=$JH" "$REPO/$WD/gradlew" -p "$REPO/$WD" compileTestJava "--console=plain")
while IFS= read -r e; do cmd+=("-x" "$e"); done < <(jq -r '.run.gradle_excludes[]' "$CFG")

if [ "${COMPILE_DRY:-0}" = "1" ]; then printf '%q ' "${cmd[@]}"; echo; exit 0; fi

gradle_lock_acquire "$REPO/$WD"
LOG="$(mktemp "${TMPDIR:-/tmp}/hektor-compile.XXXXXX")"
"${cmd[@]}" > "$LOG" 2>&1; rc=$?
# surface the javac error lines (path:line: error: …) + any gradle "what went wrong"
errs="$(grep -E '\.java:[0-9]+: error:|error: |Unable to delete|Execution failed for task' "$LOG" | head -20 | sed -E 's/\x1b\[[0-9;]*m//g')"
ok=$([ $rc -eq 0 ] && echo true || echo false)
jq -n --argjson ok "$ok" --arg e "$errs" '{ok:$ok, errors:($e|split("\n")|map(select(length>0)))}'
rm -f "$LOG"
[ "$ok" = true ]
