#!/bin/bash
# kits/flaky-triage-kit/scripts/package-kit.sh — stage + zip the kit for external distribution.
#
# WHY (P5 packaging leak, kernel.md §13): a prior `flaky-triage-kit.zip` shipped a
# `.playwright-mcp/` directory of dev-session captures (browser console logs + page snapshots)
# alongside stray screenshots (`*.png`) and `.DS_Store` cruft — none of that is part of the kit,
# and the captures can carry internal hostnames/URLs picked up incidentally while driving a
# browser against internal infra. This script (a) stages a CLEAN copy of the kit, excluding known
# dev/build cruft, then (b) greps the STAGED tree for internal hostname patterns and refuses
# (nonzero exit, no zip written) if any turn up OUTSIDE the two files that are SUPPOSED to carry
# them: `core/config.json` (the config seam, kernel.md §10 — "config.json — set `source_roots`")
# and `kernel.md` itself, whose §10 documents those same endpoints as the reference example
# ("Everything above is generic; another team/app swaps only this section."). Anywhere else, a
# hostname match means something leaked in that shouldn't have — refuse rather than ship it.
#
# This is intentionally NOT a general secrets scanner — it targets the ONE leak class the audit
# actually found (internal hostnames from incidental dev-session capture). It does not replace
# secrets-sweep-style review of new files added to the kit.
#
# Usage:
#   scripts/package-kit.sh              # stage, scan, zip -> kits/flaky-triage-kit.zip
#   scripts/package-kit.sh --self-test  # RED/GREEN proof: plant a hostname in a non-exempt file
#                                        # in a THROWAWAY copy and assert the scan refuses it.
#                                        # Touches no real files, writes no zip. Exits 0 iff the
#                                        # guard behaved correctly (i.e. this is a passing test,
#                                        # not "packaging succeeded").
#
# Idempotent / re-runnable: the stage dir is always rebuilt from scratch in a fresh mktemp, and
# the output zip is only touched (removed + rewritten) once the scan is clean — a failed run
# leaves any previously-published zip exactly as it was.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # kits/flaky-triage-kit/scripts
KIT="$(cd "$HERE/.." && pwd)"                             # kits/flaky-triage-kit
KITS_DIR="$(cd "$KIT/.." && pwd)"                          # kits/
OUT_ZIP="$KITS_DIR/flaky-triage-kit.zip"

for t in rsync zip find grep; do
  command -v "$t" >/dev/null || { echo "package-kit: $t required" >&2; exit 69; }
done

# Dev/build cruft that must never ship. Directory patterns end in / (pruned wholesale); file
# patterns are glob-matched anywhere in the tree. rsync --exclude matches at ANY depth (no
# anchoring) unless the pattern starts with '/', which is exactly what we want here.
EXCLUDES=(
  --exclude=".playwright-mcp/"
  --exclude=".achilles/"
  --exclude=".DS_Store"
  --exclude=".git/"
  --exclude="*.png"
  --exclude=".superpowers/"
  --exclude="*.swp"
  --exclude="*~"
  # core/.lock-state describes the TREE IT SITS IN (lock-kit.sh writes it there, see install.sh's
  # matching fix). If this repo's kit happened to be locked (or unlocked-after-lock) at package
  # time, rsync would carry that record straight into the zip — every consumer who unzips this as
  # a fresh source tree would inherit a claim about a lock event that never happened to THEIR copy,
  # and at "hardened" that reads back as `mismatch`, which refuses. Same class of bug, same fix:
  # never ship it. rsync excludes by basename anywhere in the tree unless anchored with a leading
  # '/', which is what we want — .lock-state only ever legitimately lives at core/.lock-state.
  --exclude=".lock-state"
)

# Internal-hostname patterns (kernel.md §13 P5). ERE, matched with `grep -E`.
HOSTNAME_RE='sahibindenlocal\.net|\.tzla\.|ocptbox'

# Files where these hostnames are INTENTIONAL, relative to the staged kit root: the config seam
# + the doc that describes it (kernel.md §10), plus this packager's OWN source — it necessarily
# carries the hostname patterns as regex/test-fixture literals (HOSTNAME_RE above, and the
# --self-test planted string), which is not a disclosure, just the guard's own code.
# scripts/scan-kit.sh (its extracted sibling, Task 2) carries the identical self-reference.
# core/tests/install-guard-test.sh is NOT here: it SHIPS (core/ is in the npm `files`
# whitelist), so it assembles its test hostname from fragments at runtime rather than
# writing it literally — exempting a shipped file would blind the guard to everything
# else in it.
ALLOWED_HOSTNAME_FILES=("core/config.json" "kernel.md" "scripts/package-kit.sh" "scripts/scan-kit.sh")

is_allowed() { # $1 = path relative to stage root
  local rel="$1" a
  for a in "${ALLOWED_HOSTNAME_FILES[@]}"; do [ "$rel" = "$a" ] && return 0; done
  return 1
}

# stage_kit <src-dir> <stage-parent-dir>
#   rsyncs <src-dir> into <stage-parent-dir>/flaky-triage-kit, excluding cruft.
stage_kit() {
  local src="$1" stage_parent="$2"
  mkdir -p "$stage_parent/flaky-triage-kit"
  rsync -a "${EXCLUDES[@]}" "$src/" "$stage_parent/flaky-triage-kit/"
}

# scan_stage <stage-parent-dir>
#   greps the staged tree for the hostname patterns outside the allowlist.
#   Prints violations (path + matching line) to stderr; returns 0 clean / 1 dirty.
scan_stage() {
  # bash 3.2: a `local` statement's later assignments cannot reference an EARLIER assignment in
  # the SAME statement under `set -u` (the RHS is expanded before any name in this command is
  # bound) — keep these on separate `local` lines rather than chaining.
  local stage_parent="$1"
  local stage_root="$stage_parent/flaky-triage-kit"
  local dirty=0 f rel
  while IFS= read -r -d '' f; do
    rel="${f#"$stage_root"/}"
    is_allowed "$rel" && continue
    if grep -aqE "$HOSTNAME_RE" "$f" 2>/dev/null; then
      dirty=1
      echo "package-kit: REFUSING — internal hostname found outside the config seam: $rel" >&2
      grep -anE "$HOSTNAME_RE" "$f" 2>/dev/null | sed "s#^#package-kit:   $rel:#" >&2
    fi
  done < <(find "$stage_root" -type f -print0)
  return $dirty
}

if [ "${1:-}" = "--self-test" ]; then
  # RED/GREEN proof: stage a THROWAWAY copy of the real kit, plant an internal hostname in a
  # file that is NOT on the allowlist, and assert scan_stage refuses it. Then, as a control,
  # confirm a clean stage (no planted violation) passes. Never touches the real kit or the real
  # zip. This is the regression test for the hostname guard itself.
  TW="$(mktemp -d)"; trap 'rm -rf "$TW"' EXIT
  fail=0

  # RED: planted violation in a non-exempt file must be refused.
  RED="$TW/red"; mkdir -p "$RED"
  stage_kit "$KIT" "$RED"
  printf 'debug note: saw it on https://leaked.apps.ocptbox.tzla.sahibindenlocal.net during a session\n' \
    >> "$RED/flaky-triage-kit/README.md"
  if scan_stage "$RED" >/tmp/package-kit-selftest-red.out 2>&1; then
    echo "package-kit: SELF-TEST FAILED — planted hostname in README.md was NOT refused" >&2
    fail=1
  else
    echo "package-kit: self-test RED ok — planted hostname in README.md correctly refused" >&2
  fi

  # GREEN (control): the same stage, unmodified, must pass (proves the guard isn't just always
  # failing — it fails FOR THE PLANTED REASON, not by accident).
  GREEN="$TW/green"; mkdir -p "$GREEN"
  stage_kit "$KIT" "$GREEN"
  if scan_stage "$GREEN" >/tmp/package-kit-selftest-green.out 2>&1; then
    echo "package-kit: self-test GREEN ok — unmodified staged kit scans clean" >&2
  else
    echo "package-kit: SELF-TEST FAILED — unmodified staged kit was refused (false positive):" >&2
    cat /tmp/package-kit-selftest-green.out >&2
    fail=1
  fi

  rm -f /tmp/package-kit-selftest-red.out /tmp/package-kit-selftest-green.out
  if [ "$fail" -eq 0 ]; then
    echo "package-kit: self-test PASSED (RED refused, GREEN clean)" >&2
    exit 0
  else
    exit 1
  fi
fi

# --- real packaging run ---
STAGE_PARENT="$(mktemp -d)"; trap 'rm -rf "$STAGE_PARENT"' EXIT
stage_kit "$KIT" "$STAGE_PARENT"

if ! scan_stage "$STAGE_PARENT"; then
  echo "package-kit: hostname scan failed — refusing to package. Fix the file(s) above (or add" >&2
  echo "package-kit: them to ALLOWED_HOSTNAME_FILES in this script if the disclosure is intentional" >&2
  echo "package-kit: and reviewed) and re-run." >&2
  exit 77
fi
echo "package-kit: hostname scan clean (only core/config.json + kernel.md carry internal hostnames)" >&2

rm -f "$OUT_ZIP"
( cd "$STAGE_PARENT" && zip -rq -X "$OUT_ZIP" flaky-triage-kit )
echo "package-kit: wrote $OUT_ZIP" >&2
