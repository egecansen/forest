#!/bin/bash
# core/tests/run-all.sh — the whole kit suite, one command.
#
# There were fifteen suites and no way to run them but a hand-written for-loop, which meant in
# practice they ran when someone remembered. For a kit whose entire value is not producing wrong
# verdicts, an unrunnable suite is the expensive kind of gap: `install-guard-test.sh` had been
# failing on a real, still-open defect (built tarballs committed to the tracked tree) and nothing
# said so.
#
#   bash core/tests/run-all.sh              # everything
#   bash core/tests/run-all.sh ledger gate  # only suites whose name contains one of these
#   bash core/tests/run-all.sh --list       # names, run nothing
#
# Exit 0 iff every selected suite exited 0. Per-suite output is captured and reprinted only for
# failures, so a green run is a screenful and a red one shows exactly what broke.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# macOS ships bash 3.2: no `mapfile`, and `${#arr[@]}` on an empty array trips `set -u`. Both
# are worked around the same way the rest of core/ does — read into the array by hand, and expand
# with the `${arr[@]+"${arr[@]}"}` guard. Do not "modernise" this to bash 4 syntax; the kit's
# primary platform is the one that does not have it.
ALL=()
while IFS= read -r t; do ALL+=("$t"); done < <(find "$HERE" -maxdepth 1 -name '*-test.sh' -type f | sort)
[ "${#ALL[@]:-0}" -gt 0 ] || { echo "run-all: no *-test.sh found in $HERE" >&2; exit 1; }

if [ "${1:-}" = "--list" ]; then
  for t in "${ALL[@]}"; do basename "$t" .sh; done
  exit 0
fi

SUITES=()
if [ $# -gt 0 ]; then
  for t in "${ALL[@]}"; do
    for pat in "$@"; do
      case "$(basename "$t")" in *"$pat"*) SUITES+=("$t"); break;; esac
    done
  done
  [ "${#SUITES[@]:-0}" -gt 0 ] || { echo "run-all: nothing matched: $*" >&2; exit 1; }
else
  SUITES=("${ALL[@]}")
fi

# The kit prints an integrity banner on every core/* invocation; at the `unlocked` tier that is one
# line per call and would bury the results. It is dropped from the SUMMARY only — a failing suite's
# captured output is reprinted whole, banner included, because the tier can itself be the reason.
strip_banner() { grep -v '^integrity: ' || true; }

started=$(date +%s)
failed=(); total=0
for t in "${SUITES[@]}"; do
  name="$(basename "$t" .sh)"
  total=$((total + 1))
  printf '  %-28s ' "$name"
  out="$(bash "$t" 2>&1)"; rc=$?
  # Suites report their own tallies on the last non-banner line ("<name>: N passed, M failed").
  tally="$(printf '%s\n' "$out" | strip_banner | grep -E '[0-9]+ passed' | tail -1)"
  if [ "$rc" -eq 0 ]; then
    printf 'ok    %s\n' "${tally:-}"
  else
    printf 'FAIL  %s\n' "${tally:-exit $rc}"
    failed+=("$name")
    printf '%s\n' "$out" | grep -E '^FAIL' | sed 's/^/      /' | head -20
  fi
done
elapsed=$(( $(date +%s) - started ))

echo
if [ "${#failed[@]:-0}" -eq 0 ]; then
  echo "run-all: $total suites green (${elapsed}s)"
  exit 0
fi
echo "run-all: ${#failed[@]} of $total suites FAILED (${elapsed}s): ${failed[*]}"
echo "run-all: rerun one with  bash core/tests/run-all.sh ${failed[0]%-test}"
exit 1
