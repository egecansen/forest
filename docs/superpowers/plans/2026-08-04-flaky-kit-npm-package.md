# Flaky-Triage Kit as an npm Package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the flaky-triage kit as a versioned npm package consumed with `npx`, so it can reach anyone without the source directory and two installs can be told apart.

**Architecture:** `package.json`'s `files` whitelist replaces the packager's staging; `npm pack` replaces its zipping; the hostname scan — the half that matters — is extracted to `scripts/scan-kit.sh` and wired as `prepack`. `install.sh` records the version into each install the way it already records `core/.harness`. A `build` subcommand packs and then verifies the artifact.

**Tech Stack:** bash 3.2 (macOS system bash), npm 11.16.0 / node v26.3.1, `jq`. The kit's tests are plain bash scripts under `core/tests/`.

## Global Constraints

- **bash 3.2 compatible** — macOS system bash. In particular, a `local` statement's later assignments cannot reference an earlier assignment in the same statement under `set -u`; use separate `local` lines.
- **Do NOT run `core/lock-kit.sh lock` or `unlock`.** A bare `lock` shells out to `sudo chown -R root` and will hang on a password prompt nobody can answer. Every tier arrives as a string parameter or a staged file.
- **Run `core/tests/lock-tier-test.sh` unmodified.**
- **Test fixtures live under `mktemp -d`**, never in a real project, and are cleaned up. If a fixture is made read-only, `chmod` it back so it can be removed.
- **stderr only** — four entrypoints emit a machine-read contract on stdout.
- **Never publish.** No `publishConfig`, no `npm publish` in any script, no registry configuration.
- **No AI trailers in commit messages** — no `Co-Authored-By`, no "Generated with", no session link.
- **Baseline: 1034 assertions, 0 failures, across 12 files.** Run from `kits/flaky-triage-kit/` with `for f in core/tests/*.sh; do bash "$f" 2>&1 | tail -1; done`. Derive and state your own total.
- **Mutation is the only accepted evidence for a new assertion**: show it applied, and show it produced the state the assertion names. Five assertions in this repo's recent history shipped unable to fail, and the `.lock-state` defect this plan's spec describes survived 1023 of them.

## Three facts verified before this plan was written

Do not re-derive these; do not assume anything that contradicts them.

1. **npm tarball entries are prefixed `package/`**, not the package name. `tar tzf demo-kit-1.2.3.tgz` gave `package/cli`, `package/package.json`, `package/core/a.sh`. The retired zip used `flaky-triage-kit/`, so anything copied from the zip era looks in the wrong place.
2. **`prepack` runs on `npm pack`** — verified by a script that wrote to stderr.
3. **`npm pack --dry-run --json`** emits the file list npm would include: `['cli', 'core/a.sh', 'package.json']` for a `files: ["core/","cli"]` whitelist. `package.json` is always included regardless of `files`; `scripts/` was excluded by the whitelist.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `package.json` | manifest: name, version, bin, files whitelist, prepack hook | create |
| `scripts/scan-kit.sh` | the hostname guard, standalone and callable as `prepack` | create |
| `scripts/package-kit.sh` | staging + zipping, now done by npm | delete |
| `hektor-triage-kit` | CLI — gains `build` | modify |
| `install.sh` | gains the `core/.version` write | modify |
| `core/.gitignore` | gains `.version` | modify |
| `core/tests/install-guard-test.sh` | owns installer + packaging assertions | modify |
| `README.md`, `kernel.md` | how to build and install | modify |
| `kits/flaky-triage-kit.zip` | the retired artifact | delete |

---

### Task 1: `package.json` and the `files` whitelist

**Files:**
- Create: `kits/flaky-triage-kit/package.json`
- Test: `kits/flaky-triage-kit/core/tests/install-guard-test.sh`

**Interfaces:**
- Produces: a package named `hektor-flaky-triage` at version `1.0.0`, whose single `bin` entry `hektor-triage-kit` points at the existing `./hektor-triage-kit` CLI. Later tasks read the version from this file with `jq -r .version` and add a `prepack` script to it.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/install-guard-test.sh`, before its final summary line:

```bash
# --- packaging: the files whitelist decides what ships ------------------------
# npm's `files` is a WHITELIST: a new kind of dev cruft is excluded by default
# rather than needing a new rule after it escapes. That is why this replaced the
# packager's blacklist. Driven through `npm pack --dry-run --json`, which is npm's
# own resolution rather than our reading of it.
pack_list() {  # $1 = kit dir -> newline-separated paths npm would ship
  ( cd "$1" && npm pack --dry-run --json 2>/dev/null \
      | python3 -c 'import sys,json; print("\n".join(f["path"] for f in json.load(sys.stdin)[0]["files"]))' )
}

PKG_SRC="$(mktemp -d)"
cp -R "$KIT_SRC/." "$PKG_SRC/kit/" 2>/dev/null || { mkdir -p "$PKG_SRC/kit"; cp -R "$KIT_SRC/." "$PKG_SRC/kit/"; }
# plant every kind of thing that must NOT ship
mkdir -p "$PKG_SRC/kit/.achilles" "$PKG_SRC/kit/.playwright-mcp"
echo x > "$PKG_SRC/kit/.achilles/note.md"
echo x > "$PKG_SRC/kit/.playwright-mcp/capture.txt"
echo x > "$PKG_SRC/kit/.DS_Store"
echo x > "$PKG_SRC/kit/shot.png"
printf '{"tier":"hardened","at":"2020-01-01T00:00:00Z"}\n' > "$PKG_SRC/kit/core/.lock-state"
LIST="$(pack_list "$PKG_SRC/kit")"

for want in core/ adapters/ install.sh hektor-triage-kit README.md kernel.md cross-harness.md enforcement-codeowners.md; do
  case "$want" in
    */) printf '%s\n' "$LIST" | grep -q "^${want}" && ok || bad "files must ship $want" ;;
    *)  printf '%s\n' "$LIST" | grep -qx "$want" && ok || bad "files must ship $want" ;;
  esac
done
for junk in core/.lock-state .achilles/note.md .playwright-mcp/capture.txt .DS_Store shot.png scripts/scan-kit.sh scripts/package-kit.sh; do
  printf '%s\n' "$LIST" | grep -q "$junk" && bad "files must NOT ship $junk" || ok
done
rm -rf "$PKG_SRC"
```

`KIT_SRC` is the kit root the file already computes for its other fixtures — reuse the existing variable rather than introducing a second way to find the kit. If the file names it differently, use its name.

- [ ] **Step 2: Run it to verify it fails**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -20`
Expected: FAIL on every `files must ship …` assertion — `npm pack` errors without a `package.json`, so `pack_list` returns empty.

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "hektor-flaky-triage",
  "version": "1.0.0",
  "description": "Flaky-test triage kit: an engine, two enforced gates and a skill, installed into a repo for Claude Code, Cursor or any AGENTS.md-reading agent.",
  "bin": { "hektor-triage-kit": "./hektor-triage-kit" },
  "files": [
    "core/",
    "adapters/",
    "install.sh",
    "hektor-triage-kit",
    "README.md",
    "kernel.md",
    "cross-harness.md",
    "enforcement-codeowners.md"
  ],
  "license": "UNLICENSED",
  "private": true
}
```

`"private": true` is a second, independent guard against publishing: npm refuses `npm publish` on a private package regardless of what any script says. The spec's "never publish" is thereby enforced by npm itself, not only by our own restraint.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 5: Mutation — prove the whitelist is what excludes**

Add `"scripts/"` to `files`, re-run.
Expected: *"files must NOT ship scripts/scan-kit.sh"* — or `scripts/package-kit.sh` while it still exists — reddens, and nothing else does.
Revert, confirm `git diff` shows only the intended file, re-run green.

- [ ] **Step 6: Run the whole suite and commit**

```bash
for f in core/tests/*.sh; do bash "$f" 2>&1 | tail -1; done
git add kits/flaky-triage-kit/package.json kits/flaky-triage-kit/core/tests/install-guard-test.sh
git commit -m "feat(kit): a package manifest, with files as the whitelist

The packager's blacklist needed a new --exclude every time something new
leaked. A whitelist excludes the next kind by default."
```

---

### Task 2: extract the hostname guard and wire it as `prepack`

**Files:**
- Create: `kits/flaky-triage-kit/scripts/scan-kit.sh`
- Modify: `kits/flaky-triage-kit/package.json` (add the `prepack` script)
- Test: `kits/flaky-triage-kit/core/tests/install-guard-test.sh`

**Interfaces:**
- Consumes: `package.json` from Task 1.
- Produces: `scripts/scan-kit.sh` — exit 0 clean, exit 1 dirty, violations to stderr. `scripts/scan-kit.sh --self-test` exits 0 iff the guard correctly refuses a planted hostname. `package.json` gains `"scripts": { "prepack": "scripts/scan-kit.sh" }`.

**Why this half survives:** the scan exists because a prior zip shipped internal hostnames picked up incidentally from dev-session browser captures. `files` and `npm pack` replace the staging and zipping; nothing replaces this.

- [ ] **Step 1: Write the failing test**

Append to `core/tests/install-guard-test.sh`:

```bash
# --- packaging: the hostname guard --------------------------------------------
# The scan is the half of the retired packager that had to survive. A dirty tree
# must not become a tarball, so it runs as prepack.
SCAN_SRC="$(mktemp -d)"
cp -R "$KIT_SRC/." "$SCAN_SRC/kit/" 2>/dev/null || { mkdir -p "$SCAN_SRC/kit"; cp -R "$KIT_SRC/." "$SCAN_SRC/kit/"; }

bash "$SCAN_SRC/kit/scripts/scan-kit.sh" "$SCAN_SRC/kit" >/dev/null 2>&1 \
  && ok || bad "a clean kit must pass the hostname scan"

printf 'see chroma-s-test-applications.apps.ocptbox.tzla.sahibindenlocal.net\n' >> "$SCAN_SRC/kit/README.md"
bash "$SCAN_SRC/kit/scripts/scan-kit.sh" "$SCAN_SRC/kit" >/dev/null 2>&1 \
  && bad "a hostname in a non-exempt file must be refused" || ok

git -C "$SCAN_SRC/kit" checkout README.md 2>/dev/null || cp "$KIT_SRC/README.md" "$SCAN_SRC/kit/README.md"
printf '\nocptbox.tzla.sahibindenlocal.net\n' >> "$SCAN_SRC/kit/kernel.md"
bash "$SCAN_SRC/kit/scripts/scan-kit.sh" "$SCAN_SRC/kit" >/dev/null 2>&1 \
  && ok || bad "kernel.md documents those endpoints deliberately and must stay exempt"

bash "$SCAN_SRC/kit/scripts/scan-kit.sh" --self-test >/dev/null 2>&1 \
  && ok || bad "the guard's own self-test must pass"
rm -rf "$SCAN_SRC"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -20`
Expected: FAIL — `scripts/scan-kit.sh` does not exist, so every invocation is a non-zero "no such file".

- [ ] **Step 3: Create `scripts/scan-kit.sh`**

```bash
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
# Extracted 2026-08-04 from scripts/package-kit.sh, which also staged and zipped.
# npm's `files` whitelist does the staging and `npm pack` does the zipping; this
# is the half that had no replacement. Wired as `prepack`, so a dirty tree cannot
# become a tarball.
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
# which is not a disclosure, just the guard's own code.
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
  echo "scan-kit: self-test OK (clean tree passes, planted hostname refused)"
  exit 0
fi

scan_tree "${1:-$KIT_DEFAULT}"
```

Then `chmod +x scripts/scan-kit.sh`.

- [ ] **Step 4: Wire it as `prepack`**

Add to `package.json`, after `"bin"`:

```json
  "scripts": { "prepack": "scripts/scan-kit.sh" },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 6: Mutation — prove the exemption list is load-bearing**

Remove `"kernel.md"` from `ALLOWED_HOSTNAME_FILES`, re-run.
Expected: *"kernel.md documents those endpoints deliberately and must stay exempt"* reddens, and nothing else does.
Revert, re-run green.

- [ ] **Step 7: Prove `prepack` actually gates a pack**

Run, from a `mktemp -d` copy of the kit that has a hostname planted in `README.md`:

```bash
cd <copy> && npm pack 2>&1 | tail -5; echo "rc=$?"; ls *.tgz 2>/dev/null || echo "no tarball — correct"
```

Expected: non-zero, the `scan-kit: REFUSING` line, and **no `.tgz` written**. Record the output in your report; this is the property `prepack` exists for and no unit assertion covers it.

- [ ] **Step 8: Run the whole suite and commit**

```bash
for f in core/tests/*.sh; do bash "$f" 2>&1 | tail -1; done
git add kits/flaky-triage-kit/scripts/scan-kit.sh kits/flaky-triage-kit/package.json kits/flaky-triage-kit/core/tests/install-guard-test.sh
git commit -m "feat(kit): extract the hostname guard and gate packing on it

files and npm pack replace the packager's staging and zipping. The scan is
the half nothing replaces, so it becomes prepack: a dirty tree cannot
become a tarball."
```

---

### Task 3: the installed kit records which version it is

**Files:**
- Modify: `kits/flaky-triage-kit/install.sh` (beside the `core/.harness` write at `:115`)
- Modify: `kits/flaky-triage-kit/core/.gitignore`
- Modify: `kits/flaky-triage-kit/hektor-triage-kit` (report it from `status`)
- Test: `kits/flaky-triage-kit/core/tests/install-guard-test.sh`

**Interfaces:**
- Consumes: `package.json`'s `version` from Task 1.
- Produces: `$SKILL_DIR/core/.version` in every install — two space-separated tokens, the version and the install instant: `1.0.0 2026-08-04T07:16:38Z`. Absent when the source has no readable `package.json`, and absent in every install predating this change.

**The distinction that must not be lost:** a version file *should* travel with a copy — it describes which build this is. `.lock-state` must *not* — it describes one tree's lock state. Same `core/` mechanism, opposite correct behaviour. Writing `.version` at install time means **there is no source `.version` for `cp -R` to carry**, so the ambiguity is removed structurally rather than by a comment asking the next reader to be careful.

- [ ] **Step 1: Write the failing test**

```bash
# --- the install records its version ------------------------------------------
# "what version is this install?" was unanswerable twice: a broken worktree's age
# had to be inferred from file presence. Written at install time like
# core/.harness, and deliberately ABSENT from the source tree — see install.sh.
VER_SRC="$(mktemp -d)"; VER_P1="$(mktemp -d)"; VER_P2="$(mktemp -d)"
cp -R "$KIT_SRC/." "$VER_SRC/kit/" 2>/dev/null || { mkdir -p "$VER_SRC/kit"; cp -R "$KIT_SRC/." "$VER_SRC/kit/"; }
# a distinctive version, so the assertion cannot pass by matching the real one
python3 - "$VER_SRC/kit/package.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["version"]="9.9.9-test"; json.dump(d,open(p,"w"),indent=2)
PY

( cd "$VER_P1" && git init -q . && bash "$VER_SRC/kit/install.sh" --harness claude >/dev/null 2>&1 )
V1="$VER_P1/.claude/skills/hektor-flaky-triage/core/.version"
[ -f "$V1" ] && ok || bad "install.sh must write core/.version"
[ "$(cut -d' ' -f1 < "$V1")" = "9.9.9-test" ] \
  && ok || bad "core/.version must carry package.json's version, not a literal"

# Written per-install, not copied: two installs from ONE source differ in instant.
sleep 1
( cd "$VER_P2" && git init -q . && bash "$VER_SRC/kit/install.sh" --harness claude >/dev/null 2>&1 )
V2="$VER_P2/.claude/skills/hektor-flaky-triage/core/.version"
[ "$(cut -d' ' -f2 < "$V1")" != "$(cut -d' ' -f2 < "$V2")" ] \
  && ok || bad "two installs from one source must record DIFFERENT instants — proving .version is written, not carried"

# The structural guarantee: no .version anywhere in the source.
[ -z "$(find "$KIT_SRC" -name '.version' -print -quit)" ] \
  && ok || bad "the source tree must carry no .version — that is what keeps it unlike .lock-state"
rm -rf "$VER_SRC" "$VER_P1" "$VER_P2"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -20`
Expected: FAIL on *"install.sh must write core/.version"* — the installer does not write it yet.

- [ ] **Step 3: Implement the write**

In `install.sh`, immediately after the `core/.harness` block that ends at `:116`:

```bash
# The version of the ENGINE this project received, and when it received it.
# Written here rather than shipped in the source tree: a version SHOULD travel
# with a copy (it says which build this is), which is the opposite of
# core/.lock-state, whose defect was travelling — see the rm -f above. Writing it
# per-install means there is no source .version for `cp -R` to carry, so the two
# cannot be confused into "fixing" one by breaking the other.
# No readable manifest -> no record, deliberately: an invented version is worse
# than an absent one, and `status` already reads absence as "unknown".
if [ -r "$HERE/package.json" ] && command -v jq >/dev/null 2>&1; then
  _kv="$(jq -r '.version // empty' "$HERE/package.json" 2>/dev/null)"
  [ -n "$_kv" ] && printf '%s %s\n' "$_kv" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SKILL_DIR/core/.version"
  unset _kv
fi
```

- [ ] **Step 4: Add `.version` to `core/.gitignore`**

Append:

```
# .version — written by install.sh into an INSTALLED kit, never present in the
# source. Listed here as insurance against one being created by hand: a source
# .version would be copied by install.sh's `cp -R` and would then describe the
# wrong tree, which is exactly the .lock-state defect above.
.version
```

- [ ] **Step 5: Report it from `status`**

In `hektor-triage-kit`, replace the `lock|unlock|status)` branch body's final `exec "$LK" "$sub"` with:

```bash
    if [ "$sub" = "status" ]; then
      V="$PROJ/.claude/skills/hektor-flaky-triage/core/.version"
      if [ -r "$V" ]; then
        echo "  kit version: $(cut -d' ' -f1 < "$V") (installed $(cut -d' ' -f2 < "$V"))"
      else
        echo "  kit version: unknown (installed before the kit recorded versions)"
      fi
    fi
    exec "$LK" "$sub" ;;
```

The `unknown` wording distinguishes an old install from a broken one — the distinction that cost real time diagnosing a stale worktree.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 7: Mutation — prove the per-install assertion is not decorative**

Change the write to copy instead: replace the `printf … > "$SKILL_DIR/core/.version"` line with `cp "$HERE/package.json" "$SKILL_DIR/core/.version"`.
Expected: the version assertion and the differing-instants assertion both redden.
Then instead plant a `.version` in the source tree and re-run.
Expected: *"the source tree must carry no .version"* reddens.
Revert both, re-run green.

- [ ] **Step 8: Run the whole suite and commit**

```bash
for f in core/tests/*.sh; do bash "$f" 2>&1 | tail -1; done
git add kits/flaky-triage-kit/install.sh kits/flaky-triage-kit/core/.gitignore kits/flaky-triage-kit/hektor-triage-kit kits/flaky-triage-kit/core/tests/install-guard-test.sh
git commit -m "feat(kit): an install records which version it is

Written at install time like core/.harness, and absent from the source: a
version should travel with a copy, which is the opposite of .lock-state.
Writing it per-install removes the ambiguity structurally."
```

---

### Task 4: `hektor-triage-kit build`

**Files:**
- Modify: `kits/flaky-triage-kit/hektor-triage-kit`
- Test: `kits/flaky-triage-kit/core/tests/install-guard-test.sh`

**Interfaces:**
- Consumes: `package.json` (Task 1), `prepack` (Task 2).
- Produces: `hektor-triage-kit build` — packs and verifies, printing the tarball path. Exit 66 from an installed kit; non-zero with the tarball removed when verification fails.

**Two traps this task must not fall into.** npm tarball entries are prefixed **`package/`**, not `flaky-triage-kit/` as the retired zip used. And the CLI's `help` branch prints a **hardcoded line range**, `sed -n '2,13p'` at `:40` — adding a `build` block to the header comment silently truncates the help unless that range is widened.

- [ ] **Step 1: Write the failing test**

```bash
# --- build: pack, then verify what was packed ---------------------------------
# The retired zip passed packaging and was still wrong — it carried a hardened
# .lock-state and lacked the installer fix. A build that does not check its own
# output is how that ships.
BLD="$(mktemp -d)"
cp -R "$KIT_SRC/." "$BLD/kit/" 2>/dev/null || { mkdir -p "$BLD/kit"; cp -R "$KIT_SRC/." "$BLD/kit/"; }
( cd "$BLD/kit" && bash ./hektor-triage-kit build >"$BLD/out" 2>"$BLD/err" ); BRC=$?
[ "$BRC" = 0 ] && ok || bad "build must succeed on a clean kit (rc=$BRC: $(tail -1 "$BLD/err"))"
TGZ="$(ls "$BLD/kit"/hektor-flaky-triage-*.tgz 2>/dev/null | head -1)"
[ -n "$TGZ" ] && ok || bad "build must leave a versioned tarball in the kit dir"
grep -q "$(basename "${TGZ:-none}")" "$BLD/out" && ok || bad "build must print the artifact path"
tar tzf "$TGZ" 2>/dev/null | grep -q '^package/core/apply.sh$' \
  && ok || bad "npm tarballs are prefixed package/, and the engine must be inside"
tar tzf "$TGZ" 2>/dev/null | grep -q 'lock-state' && bad "a tarball must never carry .lock-state" || ok

# build refuses from an INSTALLED kit, which has only SKILL.md and core/
BINST="$(mktemp -d)"
( cd "$BINST" && git init -q . && bash "$BLD/kit/install.sh" --harness claude >/dev/null 2>&1 )
( cd "$BINST/.claude/skills/hektor-flaky-triage" && bash "$BLD/kit/hektor-triage-kit" build >/dev/null 2>&1 ); IRC=$?
[ "$IRC" = 66 ] && ok || bad "build from an installed kit must exit 66, got $IRC"
rm -rf "$BLD" "$BINST"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -20`
Expected: FAIL — `build` is an unknown subcommand, so the CLI exits 64.

- [ ] **Step 3: Implement `build`**

Add a case branch before the `-h|--help|help)` branch:

```bash
  build)
    # Source-checkout only: an install carries SKILL.md and core/ and nothing
    # else, so there is no manifest to pack. Say which directory to use rather
    # than failing obscurely inside npm.
    [ -f "$HERE/package.json" ] || {
      echo "hektor-triage-kit: build needs the kit SOURCE checkout (no package.json in $HERE)." >&2
      echo "hektor-triage-kit: an installed kit carries only SKILL.md and core/. Run build from kits/flaky-triage-kit." >&2
      exit 66; }
    command -v npm >/dev/null 2>&1 || { echo "hektor-triage-kit: build requires npm" >&2; exit 69; }
    # cwd is the kit root on purpose: `npm pack` writes to the CURRENT directory,
    # so inheriting the caller's would scatter artifacts wherever they stood.
    TGZ="$(cd "$HERE" && npm pack --silent 2>/dev/null | tail -1)"
    [ -n "$TGZ" ] && [ -f "$HERE/$TGZ" ] || {
      echo "hektor-triage-kit: build FAILED — npm pack wrote no artifact (the prepack hostname scan refuses a dirty tree)." >&2
      exit 70; }
    # Verify what was actually produced. The retired zip packaged cleanly and was
    # still wrong; a build that does not read its own output cannot say otherwise.
    bad=0
    for pat in 'lock-state' '\.achilles/' '\.playwright-mcp/' '\.DS_Store' '\.png$' '\.superpowers/' '^package/scripts/'; do
      if tar tzf "$HERE/$TGZ" 2>/dev/null | grep -qE "$pat"; then
        echo "hektor-triage-kit: build FAILED — artifact contains $pat" >&2; bad=1
      fi
    done
    T="$(mktemp -d)"
    if tar xzf "$HERE/$TGZ" -C "$T" package/install.sh 2>/dev/null; then
      cmp -s "$T/package/install.sh" "$HERE/install.sh" || {
        echo "hektor-triage-kit: build FAILED — the packed install.sh differs from the source's" >&2; bad=1; }
    else
      echo "hektor-triage-kit: build FAILED — the artifact has no package/install.sh" >&2; bad=1
    fi
    rm -rf "$T"
    [ "$bad" = 0 ] || { rm -f "$HERE/$TGZ"; echo "hektor-triage-kit: removed the bad artifact" >&2; exit 71; }
    echo "built: $HERE/$TGZ"
    echo "install it with:  npm i -g $HERE/$TGZ   (then: hektor-triage-kit install)"
    echo "or run directly:  npx $HERE install --harness claude" ;;
```

- [ ] **Step 4: Widen the help range and document `build`**

Add to the header comment, after the `install` block:

```
#   hektor-triage-kit build
#       Pack the kit into a versioned tarball (npm pack) and VERIFY it: no .lock-state,
#       no dev cruft, and a packed install.sh identical to the source's. Source checkout
#       only — an installed kit carries no manifest. A failed verification deletes the
#       artifact rather than leaving a bad one on disk.
```

Then update `:40`'s `sed -n '2,13p'` to the new last line of the header comment. **Verify by running `hektor-triage-kit help` and reading the output**, not by counting in your head — a truncated help is silent.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 6: Mutation — prove verification is not decorative**

In a `mktemp -d` copy of the kit, make the packed `install.sh` differ from the source's by appending a line to `install.sh` *after* `npm pack` would read it — simplest: temporarily change the `cmp -s` line to `true`, then plant `core/.lock-state` in the copy and run `build`.
Expected: with `cmp` disabled the `.lock-state` check still fails the build and removes the tarball; restore `cmp`, then instead disable the `for pat` loop and plant a mismatched `install.sh`.
Expected: the `cmp` check fails the build and removes the tarball.
Each mutation must show **the tarball is gone afterwards** — the removal is the property, not the message.
Revert, re-run green.

- [ ] **Step 7: Run the whole suite and commit**

```bash
for f in core/tests/*.sh; do bash "$f" 2>&1 | tail -1; done
git add kits/flaky-triage-kit/hektor-triage-kit kits/flaky-triage-kit/core/tests/install-guard-test.sh
git commit -m "feat(kit): build packs the kit and verifies the artifact

The retired zip packaged cleanly and was still wrong. A failed check
deletes the tarball rather than leaving a bad one on disk."
```

---

### Task 5: retire the packager and the zip, and document the new path

**Files:**
- Delete: `kits/flaky-triage-kit/scripts/package-kit.sh`, `kits/flaky-triage-kit.zip`
- Modify: `kits/flaky-triage-kit/README.md`, `kits/flaky-triage-kit/kernel.md`
- Test: `kits/flaky-triage-kit/core/tests/install-guard-test.sh`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: no new interface. The kit's only build path is `hektor-triage-kit build`.

- [ ] **Step 1: Sweep for every reference before deleting**

```bash
grep -rn "package-kit\|flaky-triage-kit\.zip" kits/ docs/ README.md scripts/ 2>/dev/null | grep -v '\.achilles'
```

Read every hit. A doc that still tells a reader to run `scripts/package-kit.sh` is a doc that sends them to a deleted file. **Enumerate what you found in your report, including the ones you judged fine** — across two earlier branches, seven sweep rounds each ended with a survivor, and the last one evaded a phrase grep by using different words.

- [ ] **Step 2: Write the failing test**

```bash
# --- the retired packager stays retired ---------------------------------------
[ ! -f "$KIT_SRC/scripts/package-kit.sh" ] \
  && ok || bad "scripts/package-kit.sh is retired; scan-kit.sh + npm pack replace it"
[ ! -f "$KIT_SRC/../flaky-triage-kit.zip" ] \
  && ok || bad "the zip is retired; two artifacts means one goes stale"
grep -rqn "package-kit\.sh" "$KIT_SRC" --exclude-dir=.achilles 2>/dev/null \
  && bad "a doc or script still points at the retired packager" || ok
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -10`
Expected: FAIL on all three — both files still exist and are still referenced.

- [ ] **Step 4: Delete, and rewrite the references**

```bash
git rm kits/flaky-triage-kit/scripts/package-kit.sh kits/flaky-triage-kit.zip
```

Then rewrite every hit from Step 1. The replacement text for a "how to package" section:

```markdown
## Building a distributable

    hektor-triage-kit build

Packs the kit into `hektor-flaky-triage-<version>.tgz` and verifies it: no
`.lock-state`, no dev cruft, and a packed `install.sh` identical to the source's.
A failed check deletes the artifact rather than leaving a bad one on disk.
Packing is gated on `scripts/scan-kit.sh`, which refuses a tree carrying internal
hostnames outside `core/config.json` and `kernel.md`.

Install it anywhere:

    npm i -g ./hektor-flaky-triage-1.0.0.tgz && hektor-triage-kit install
    npx /path/to/kits/flaky-triage-kit install --harness claude
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash core/tests/install-guard-test.sh 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and commit**

```bash
for f in core/tests/*.sh; do bash "$f" 2>&1 | tail -1; done
git add -A kits/
git commit -m "chore(kit): retire package-kit.sh and the zip

npm pack and the files whitelist replace the staging and zipping; the scan
survives as prepack. Two artifacts means one goes stale, and the one that
went stale is the one we had."
```

---

## Self-Review

**Spec coverage.** §1 `package.json` → Task 1. §2 `files` whitelist → Task 1. §3 `prepack` scan → Task 2. §4 `build` + verification → Task 4. §5 `core/.version` at install, reported by `status` → Task 3. §6 consumption → documented in Tasks 4 and 5, exercised by Task 4's `npx`/`npm i -g` lines. §7 retiring the zip and the packager → Task 5. Spec testing items 1-2 → Task 1; 3 → Task 2; 4-5 → Task 4; 6 → verified before this plan was written and recorded under "Three facts"; 7-9 → Task 3. "What this does not do": never publishing is enforced twice — no publish script anywhere, and `"private": true` makes npm itself refuse.

**Placeholder scan.** No TBD/TODO. Every code step carries its code. Task 1's test reuses `KIT_SRC` "or the file's name for it" — a bounded instruction to read one variable, not a placeholder, and it is the only one.

**Type consistency.** `hektor-flaky-triage` is the package name in Tasks 1, 4 and 5; `hektor-triage-kit` is the bin and the CLI throughout. `scripts/scan-kit.sh` is created in Task 2 and referenced under that exact name in Task 2's `prepack`, its own allowlist, and Task 5's replacement docs. `core/.version`'s two-token format is written in Task 3 and read by Task 3's `status` with the same `cut -d' ' -f1/-f2`. Exit codes: 64 unknown subcommand (pre-existing), 66 build-from-install, 69 npm missing, 70 no artifact, 71 verification failed — 66 matches the CLI's existing not-installed code, and the three new ones do not collide with it or with each other.

**One risk worth naming.** Task 2's `prepack` runs the scan over the whole source tree, which is a superset of what ships — `scripts/` is scanned but never packaged. That is deliberate: scanning exactly the shipped set would mean reimplementing npm's `files` resolution, and a superset is the safe direction to be wrong in. It is why `scripts/scan-kit.sh` must stay in its own allowlist.
