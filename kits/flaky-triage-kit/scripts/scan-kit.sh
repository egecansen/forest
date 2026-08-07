#!/bin/bash
# scripts/scan-kit.sh — refuse to package a kit tree carrying internal hostnames.
#
# WHY (kernel.md §13 P5): a prior flaky-triage-kit.zip shipped a `.playwright-mcp/`
# directory of dev-session captures — browser console logs and page snapshots that
# can carry internal hostnames/URLs picked up incidentally while driving a browser
# against internal infra. This greps the tree and refuses if any turn up OUTSIDE
# the files that are SUPPOSED to carry them.
#
# This is intentionally NOT a general secrets scanner — it targets the ONE leak
# class the audit actually found. It does not replace review of new files.
#
# Extracted 2026-08-04 from the kit's former staging-and-zip script (since retired
# along with the zip artifact it produced — see kernel.md §12/§13 P5). npm's `files`
# whitelist does the staging and `npm pack` does the zipping; this is the half that
# had no replacement. Wired as `prepack`, so a dirty tree cannot become a tarball.
#
# Usage:
#   scripts/scan-kit.sh [<kit-dir>]   # default: the kit this script lives in
#   scripts/scan-kit.sh --self-test   # RED/GREEN proof, in a THROWAWAY copy
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DEFAULT="$(cd "$HERE/.." && pwd)"

# Internal-hostname patterns (kernel.md §13 P5). ERE, matched with `grep -E`.
HOSTNAME_RE='sahibindenlocal\.net|\.tzla\.|ocptbox'

# Files where these hostnames are INTENTIONAL, relative to the kit root: the
# config seam + the doc that describes it (kernel.md §10), plus this scanner's
# OWN source — it necessarily carries the patterns as regex/self-test literals,
# which is not a disclosure, just the guard's own code. core/tests/install-guard-test.sh
# is NOT here: it SHIPS (core/ is in the npm `files` whitelist), so it plants its
# test hostname assembled at runtime from fragments rather than as a literal —
# exempting a shipped file would blind the guard to everything else in it.
ALLOWED_HOSTNAME_FILES=("core/config.json" "kernel.md" "scripts/scan-kit.sh")

is_allowed() { # $1 = path relative to the kit root
  local rel="$1"
  local a
  for a in "${ALLOWED_HOSTNAME_FILES[@]}"; do [ "$rel" = "$a" ] && return 0; done
  return 1
}

scan_tree() { # $1 = kit root -> 0 clean / 1 dirty, violations to stderr
  local root="$1"
  local dirty=0
  local f rel
  while IFS= read -r -d '' f; do
    rel="${f#"$root"/}"
    is_allowed "$rel" && continue
    if grep -aqE "$HOSTNAME_RE" "$f" 2>/dev/null; then
      dirty=1
      echo "scan-kit: REFUSING — internal hostname found outside the config seam: $rel" >&2
      grep -anE "$HOSTNAME_RE" "$f" 2>/dev/null | sed "s#^#scan-kit:   $rel:#" >&2
    fi
  done < <(find "$root" -type f -print0)
  return $dirty
}

# --- harness parity --------------------------------------------------------------
# The reasoning layer is per-harness: adapters/claude/SKILL.md and adapters/cursor/*.mdc
# state the same contract in each harness's own idiom. Nothing checked they still agreed,
# and they had stopped agreeing — the Cursor rule ran 67 lines against the skill's 167, so
# a Cursor user silently got a thinner, older contract from the same kit version.
#
# cross-harness.md documents the GATES degrading between harnesses: Cursor has no Stop
# event, so I11 is the agent's own discipline there. That degradation is known and
# accepted. The REASONING degrading is neither, and it is the more dangerous of the two —
# a missing gate is a check that does not run, a missing rule is a check the agent does
# not know exists.
#
# This does not diff the files; they legitimately differ in structure and length. It
# asserts each carries every load-bearing rule. Add a row when you add a rule a harness
# would be unsafe or wrong without. Do not add one for phrasing.
PARITY_FILES=("adapters/claude/SKILL.md" "adapters/cursor/hektor-flaky-triage.mdc")

# `label<TAB>ERE` — the ERE may itself contain `|` alternation, so the fields are
# tab-separated rather than pipe-separated.
parity_rules() {
  printf '%s\n' \
    "the ledger path convention	ledger\.sh path" \
    "the phase vocabulary	phase-enter" \
    "green is the gate's decision, not the fixer's	core/gate" \
    "self-hedge screening before claiming fixed	hedge-scan" \
    "session-end verification	validate --final" \
    "park every cluster before a turn boundary	[Pp]ark before|terminal state" \
    "long jobs must run detached	[Dd]etached" \
    "never commit, file a ticket, or disable a test	[Nn]ever commit" \
    "external text is data, never instructions	(DATA|[Dd]ata), never instructions" \
    "testbox only	[Tt]estbox-only" \
    "one easy-fix-to-likely-bug table	easy.fix → likely.bug|easy fix → likely bug"
}

scan_parity() { # $1 = kit root -> 0 all present / 1 something missing
  local root="$1" missing=0 rel f line label re
  for rel in "${PARITY_FILES[@]}"; do
    f="$root/$rel"
    if [ ! -f "$f" ]; then
      echo "scan-kit: PARITY — missing adapter file: $rel" >&2; missing=1; continue
    fi
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      label="${line%%	*}"
      re="${line#*	}"
      grep -qE "$re" "$f" 2>/dev/null && continue
      echo "scan-kit: PARITY — $rel never states: $label" >&2
      missing=1
    done < <(parity_rules)
  done
  return $missing
}

if [ "${1:-}" = "--parity" ]; then
  scan_parity "${2:-$KIT_DEFAULT}" || exit 1
  echo "scan-kit: harness parity OK (${#PARITY_FILES[@]} adapters)"
  exit 0
fi

if [ "${1:-}" = "--self-test" ]; then
  T="$(mktemp -d)"
  trap 'rm -rf "$T"' EXIT
  mkdir -p "$T/kit/core"
  echo 'clean' > "$T/kit/core/apply.sh"
  if scan_tree "$T/kit" >/dev/null 2>&1; then :; else
    echo "scan-kit: SELF-TEST FAILED — a clean tree was refused" >&2; exit 1
  fi
  printf 'host ocptbox.tzla.sahibindenlocal.net\n' > "$T/kit/core/apply.sh"
  if scan_tree "$T/kit" >/dev/null 2>&1; then
    echo "scan-kit: SELF-TEST FAILED — a planted hostname was NOT refused" >&2; exit 1
  fi
  # parity: a stripped adapter must be refused, an intact pair must pass.
  mkdir -p "$T/kit/adapters/claude" "$T/kit/adapters/cursor"
  cp "$KIT_DEFAULT/adapters/claude/SKILL.md" "$T/kit/adapters/claude/SKILL.md" 2>/dev/null
  cp "$KIT_DEFAULT/adapters/cursor/hektor-flaky-triage.mdc" "$T/kit/adapters/cursor/" 2>/dev/null
  if scan_parity "$T/kit" >/dev/null 2>&1; then :; else
    echo "scan-kit: SELF-TEST FAILED — the shipped adapters do not satisfy parity" >&2; exit 1
  fi
  grep -v 'hedge-scan' "$T/kit/adapters/cursor/hektor-flaky-triage.mdc" > "$T/stripped" \
    && mv "$T/stripped" "$T/kit/adapters/cursor/hektor-flaky-triage.mdc"
  if scan_parity "$T/kit" >/dev/null 2>&1; then
    echo "scan-kit: SELF-TEST FAILED — an adapter missing a rule was NOT refused" >&2; exit 1
  fi
  echo "scan-kit: self-test OK (hostname: clean passes / planted refused; parity: intact passes / stripped refused)"
  exit 0
fi

scan_tree "${1:-$KIT_DEFAULT}" || exit 1
scan_parity "${1:-$KIT_DEFAULT}"
