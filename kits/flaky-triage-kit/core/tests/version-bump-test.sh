#!/bin/bash
# core/tests/version-bump-test.sh — `hektor-triage-kit build` bumps package.json's patch
# version before packing, so every build produces a DISTINCTLY NAMED artifact.
#
# Why this has its own suite rather than living in install-guard-test.sh: the property under
# test is not about the CLI's argument surface (which is what that suite guards) but about a
# side effect on a tracked file and on the artifact's filename. The regression it prevents is
# specific and silent — npm pack derives the filename from the version, so a version that
# never moves means each build overwrites the last and there is nothing to roll back to.
#
# Every case runs against a THROWAWAY minimal kit in a temp dir, never the real checkout:
# the real one's package.json is a tracked file and a test must not bump it, and a real
# `npm pack` here would pull in the whole kit tree for no added coverage. The fixture carries
# only what `build` actually inspects — package.json, scripts/scan-kit.sh (the second
# pre-check), and an install.sh (which verification compares against the packed copy).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$HERE/../../hektor-triage-kit"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1" >&2; }

command -v npm >/dev/null 2>&1 || { echo "version-bump-test: SKIPPED (no npm)"; exit 0; }

# $1 = dir to build the fixture in. Returns a kit source checkout `build` will accept.
make_fixture() {
  d="$1"; mkdir -p "$d/scripts" "$d/core"
  cp "$CLI" "$d/hektor-triage-kit"; chmod +x "$d/hektor-triage-kit"
  printf '#!/bin/bash\nexit 0\n' > "$d/scripts/scan-kit.sh"; chmod +x "$d/scripts/scan-kit.sh"
  printf '#!/bin/bash\n# fixture install.sh\n' > "$d/install.sh"
  cat > "$d/package.json" <<'JSON'
{
  "name": "fixture-kit",
  "version": "1.0.0",
  "private": true,
  "scripts": { "prepack": "scripts/scan-kit.sh" },
  "files": ["install.sh", "core/"]
}
JSON
}

version_of() { sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" | head -1; }

# --- a build bumps the patch version and names the artifact after it ----------------------
K="$WORK/k1"; make_fixture "$K"
OUT1="$(cd "$K" && bash ./hektor-triage-kit build 2>&1)"; RC1=$?
[ "$RC1" -eq 0 ] || bad "a clean build must exit 0, got $RC1: $OUT1"
[ "$(version_of "$K")" = "1.0.1" ] || bad "build must bump 1.0.0 -> 1.0.1, got $(version_of "$K")"
[ -f "$K/fixture-kit-1.0.1.tgz" ] && ok || bad "the artifact must be named for the NEW version: $(ls "$K"/*.tgz 2>/dev/null)"
# Compared against the PHYSICAL path: the CLI resolves its own location with `cd -P`, and on
# macOS $TMPDIR lives under a /var -> /private/var symlink, so the literal $K would never match.
KP="$(cd -P "$K" && pwd)"
case "$OUT1" in *"built: $KP/fixture-kit-1.0.1.tgz"*) ok ;; *) bad "the 'built:' line must name the new artifact, got: $OUT1" ;; esac

# --- THE POINT: a second build does not destroy the first artifact ------------------------
# Without the bump both builds write the same filename and the first is gone. This case is
# the whole reason the feature exists, so it asserts the old file SURVIVES, not merely that
# a new one appeared.
OUT2="$(cd "$K" && bash ./hektor-triage-kit build 2>&1)"; RC2=$?
[ "$RC2" -eq 0 ] || bad "a second build must exit 0, got $RC2: $OUT2"
[ "$(version_of "$K")" = "1.0.2" ] || bad "a second build must bump to 1.0.2, got $(version_of "$K")"
[ -f "$K/fixture-kit-1.0.2.tgz" ] && ok || bad "the second artifact must exist"
[ -f "$K/fixture-kit-1.0.1.tgz" ] && ok || bad "the FIRST artifact must survive a second build — this is the regression the bump exists to prevent"

# --- a build that fails verification still consumed its version ---------------------------
# Documented in the CLI's own comment: gaps are preferable to reusing a number whose artifact
# was deleted for being wrong. Pinned so nobody "fixes" it into reuse.
K2="$WORK/k2"; make_fixture "$K2"
: > "$K2/core/.lock-state"          # tripwire: the verifier refuses any artifact containing this
OUT3="$(cd "$K2" && bash ./hektor-triage-kit build 2>&1)"; RC3=$?
[ "$RC3" -eq 71 ] && ok || bad "an artifact containing .lock-state must exit 71, got $RC3: $OUT3"
[ -z "$(ls "$K2"/*.tgz 2>/dev/null)" ] && ok || bad "a failed verification must leave no artifact behind"
[ "$(version_of "$K2")" = "1.0.1" ] && ok || bad "a failed build still consumes its version (gaps are intended), got $(version_of "$K2")"

# --- the bump happens before packing, not after -------------------------------------------
# If it ran after, the artifact would carry the OLD version while package.json carried the
# new one — the two would disagree and `--version` would describe a file that does not exist.
K3="$WORK/k3"; make_fixture "$K3"
(cd "$K3" && bash ./hektor-triage-kit build >/dev/null 2>&1)
[ -f "$K3/fixture-kit-1.0.1.tgz" ] && [ ! -f "$K3/fixture-kit-1.0.0.tgz" ] && ok \
  || bad "the artifact must carry the POST-bump version, not the pre-bump one"

echo "version-bump-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
