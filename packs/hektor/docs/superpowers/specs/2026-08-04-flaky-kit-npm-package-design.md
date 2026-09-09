# Flaky-triage kit as an npm package — design spec

**Date:** 2026-08-04
**Repo:** `SKLS/hektor`, scoped to `kits/flaky-triage-kit/`
**Status:** approved by Egecan, pending implementation

## Problem

The kit has no versioned artifact and no way to reach anyone who does not have the
source directory.

`kits/flaky-triage-kit.zip` is the only distributable today, and rebuilding it is
a manual step nobody is reminded to take. The consequence is not hypothetical: on
2026-08-04 the working-tree zip was found carrying
`flaky-triage-kit/core/.lock-state` — a record claiming the `hardened` tier — and
lacking the installer fix that landed the same day. Anyone who unzipped it and ran
`install.sh` would have got a kit that plants a `hardened` claim on a user-owned
tree: the `mismatch` tier, refusing all thirteen entrypoints. It packaged cleanly
and was still wrong.

There is also no version marker anywhere in the kit — not in `install.sh`, not in
`kernel.md`, and there is no manifest. Two installs cannot be told apart.

## Decision

Package the kit with npm, consumed locally at first.

Settled 2026-08-04: **the kit only.** The hektor pack's 24 skills and 18 hooks are
out of scope and keep their own installer. The kit is self-contained by
construction — `adapters/` carries both gates, the vendored audit lib, the Cursor
shim and the skill; `core/` carries the engine — which is what makes it
packageable at all. Verified against a fresh install:

```
.claude/hooks/flaky-kit-self-protection-gate.sh   ← adapters/claude/
.claude/hooks/flaky-kit-delivery-gate.sh          ← adapters/claude/
.claude/hooks/lib/audit.sh                        ← adapters/_lib/
.claude/skills/hektor-flaky-triage/SKILL.md       ← adapters/claude/
.claude/skills/hektor-flaky-triage/core/          ← core/
.claude/settings.json                              ← merged registrations
```

**Local first, registry later.** `npm pack` produces a tarball consumed with
`npx <path>` or a global install. Publishing later changes resolution and nothing
else — the artifact and the commands are identical. That is the reason to choose
the npm shape over a better zip: the zip would have to be thrown away.

## Design

### 1. `package.json` in `kits/flaky-triage-kit/`

```json
{
  "name": "hektor-flaky-triage",
  "version": "1.0.0",
  "bin": { "hektor-triage-kit": "./hektor-triage-kit" },
  "files": [
    "core/", "adapters/", "install.sh", "hektor-triage-kit",
    "README.md", "kernel.md", "cross-harness.md", "enforcement-codeowners.md"
  ],
  "scripts": { "prepack": "scripts/scan-kit.sh" }
}
```

The `bin` points at the CLI that already exists and already carries
`install | lock | unlock | status | link | help`. Nothing about the CLI's
behaviour changes.

The package name and the bin name differ deliberately: `hektor-flaky-triage` is
what a consumer types (`npx hektor-flaky-triage install`), and it matches the
installed skill directory, which is the name people already see. With a single
`bin`, npx runs it regardless of the name mismatch. `hektor-triage-kit` stays the
command because it is what the CLI's own help output and the docs already say.

`1.0.0` because the kit is mature — 1034 assertions, both gates shipped — and
because this is the first artifact that can be told apart from another.

**No `kit.json`.** Forest reads one for display metadata only (`lib/packs.mjs:116`)
and treats it as optional; the kit has never had one. `package.json` is the
manifest. If a `kit.json` is ever added, `name` and `version` must not be
duplicated into it — two manifests that can disagree is the defect class this
repo keeps retracting.

### 2. `files` — a whitelist, replacing the packager's staging half

```
core/           core/.gitignore   adapters/         install.sh
hektor-triage-kit  README.md      kernel.md         cross-harness.md
enforcement-codeowners.md
```

A whitelist is stronger than `package-kit.sh`'s blacklist of dev cruft
(`.playwright-mcp/`, `.achilles/`, `*.png`, `.superpowers/`, `.DS_Store`, …):
a new kind of junk is excluded by default rather than needing a new `--exclude`.

**`core/.gitignore` is what keeps `core/.lock-state` out of an artifact — not
`files`.** An earlier draft of this section said the opposite ("`core/.lock-state`
is not in the whitelist, and npm's own `files` semantics never include it"), which
is false: `files: ["core/", …]` means *everything under `core/` minus the ignore
rules that apply there*, so `core/.lock-state` is squarely inside the whitelist and
only `core/.gitignore` removes it. Traced by execution — with every layer intact
`npm pack --dry-run` lists `core/.gitignore` and no `.lock-state`; delete
`core/.gitignore`, change nothing else, and `package/core/.lock-state` ships. Of
the three overlapping layers exactly one holds, and a maintainer who trusted the
old wording could delete `core/.gitignore` as redundant and reship the original
defect. The third layer, `build`'s own verification of the artifact it just wrote,
does hold independently: it prints `build FAILED — artifact contains lock-state`,
exits 71, and deletes the tarball.

`core/.gitignore` therefore needs its **own explicit `files` entry** alongside
`core/`. npm's always-ignore list drops every `.gitignore` from a tarball no
matter which directory is whitelisted, and naming the path explicitly is what
overrides that. Without the entry, an npm-installed project never receives the
file — the only difference between a source-checkout install and a tarball
install, and the one that decides whether a consumer commits `.lock-state` into
their own repo (§5's `.version` reaches them by the same route).

**Shipping the file is not the same as delivering it, because npm's extractor
RENAMES it.** `files` gets `core/.gitignore` into the tarball; on the way *out*
— `npm i`, `npm i -g`, `npx`, any install into `node_modules` — npm writes it to
disk as `core/.npmignore`. A plain `tar xzf` of the very same tarball writes
`core/.gitignore`. So the npm path, the only path a consumer who lacks this
repo actually uses, delivers the file under a name git never reads: the project
does not ignore `core/.lock-state`, a user who follows the installer's step 2
(`lock-kit.sh lock`) commits a record saying `hardened`, and a teammate who
clones onto a tree that is not root-owned gets `mismatch` from `integrity_tier`
— which refuses every entrypoint. Every tar-based check can be green while this
holds, which is how it was missed; only driving `npm i -g` end to end sees it.

**`install.sh` therefore normalises the name after its `cp -R`**: if
`core/.npmignore` landed in the installed tree, it is moved back to
`core/.gitignore`. That belongs in the installer rather than in one delivery
path's packaging, so that source checkout, `tar xzf` and `npm i -g` all converge
on the same installed tree. It reads as an unexplained `mv` next to the copy —
record it here, because a maintainer tidying that line away silently breaks
every npm consumer and nothing in the tar-based tests goes red.

**The normalisation is unconditional, deliberately.** A first draft guarded it
with `[ ! -f "$SKILL_DIR/core/.gitignore" ]`, which made it first-install-only:
on re-install the `cp -R` lands the new `.npmignore`, the guard sees the *old*
`.gitignore` already sitting there and skips, and the `rm -f` after it deletes
the incoming copy — so a rule added in a later kit version reached source-path
users on upgrade and silently never reached npm-path users. That was found and
fixed. The two names cannot coexist in any source tree (npm writes one, git
writes the other), so the guard protected against nothing and cost the upgrade
path; the upgrade is covered by a test that appends a rule to the *installed
package's* `core/.npmignore` and re-installs.

`scripts/` stays out. It is build tooling; a consumer never runs it, and it
carries the hostname patterns as regex literals.

### 3. `prepack` — the guard is the half of the packager that must survive

`scripts/package-kit.sh` does three things: stage, scan, zip. `files` replaces the
staging and `npm pack` replaces the zipping. **The scan is the part that matters
and it is kept.**

It exists because a prior zip shipped internal hostnames picked up incidentally
from dev-session browser captures. It greps the tree for
`sahibindenlocal\.net|\.tzla\.|ocptbox` and refuses — no artifact written — if any
appear outside the two files that document them deliberately: `core/config.json`
(the config seam) and `kernel.md` §10 (the reference example).

Extract the scan into `scripts/scan-kit.sh`, callable on its own, and wire it as
`prepack` so a dirty tree cannot become a tarball. Keep the RED/GREEN `--self-test`
that plants a hostname in a non-exempt file of a throwaway copy and asserts the
scan refuses it — that test is what proves the guard still guards.

The scan already covers exactly the tree that ships, because the kit is the unit.
Nothing needs generalizing. (A pack-scoped package would have needed it: the
pack's `skills/hektor-qagent/SKILL.md:34` names an internal Chroma endpoint that
this guard has never scanned. Out of scope here, recorded so it is not forgotten
if the pack is ever packaged.)

### 4. `hektor-triage-kit build`

Runs `npm pack` and then verifies what it produced. Verification is the point:
the 2026-08-04 zip passed packaging and was still wrong.

The artifact must not contain `core/.lock-state`, `.achilles/`, `.DS_Store`,
`.playwright-mcp/`, `*.png`, `.superpowers/`, or `scripts/`; and the packed
`install.sh` must be byte-identical to the source's. Any failure removes the
tarball and exits non-zero — a build that leaves a bad artifact on disk is how a
bad artifact gets shipped.

The tarball lands in the kit directory — `npm pack`'s default is the current
working directory, so `build` runs it with the kit root as cwd rather than
inheriting the caller's, which would scatter artifacts wherever the user happened
to stand. `build` prints the resulting path. The name is npm's own
`hektor-flaky-triage-<version>.tgz`; nothing renames it, because the version in
the filename is the point.

`build` runs from the **source checkout only**. An installed kit has just
`SKILL.md` and `core/` — no `package.json`, no `scripts/` — so it cannot build,
and must say so rather than fail obscurely. It refuses with exit 66, the code the
CLI already uses for "kit not installed here", with a message naming the source
checkout as the place to run it.

### 5. The installed kit records which version it is

`package.json` versions the *artifact*. This versions the *install*, which is the
question that has actually been unanswerable.

Twice in the work leading to this spec, "what version is this install?" had no
answer. A broken worktree's age had to be inferred from file presence —
`_wiring_repair.sh` absent means pre-2026-08-02 — and forest's whole
orphaned-units guard exists because an install froze at an old version and nothing
noticed. One command should answer it.

**`install.sh` writes `$SKILL_DIR/core/.version` at install time**, exactly as it
already writes `core/.harness` (`install.sh:115`): two tokens, the version and the
install instant.

```
1.0.0 2026-08-04T07:16:38Z
```

It reads the version from `package.json`, which sits at the kit root and is present
in both a source checkout and an unpacked tarball — npm includes `package.json` in
every tarball regardless of `files`.

**There is deliberately no `.version` in the source tree.** A version file *should*
travel with a copy — it describes which build this is — which is the opposite of
`.lock-state`, whose whole defect was travelling. Same mechanism, opposite correct
behaviour, and that is precisely how a later reader "fixes" one by breaking the
other. Writing it at install time removes the ambiguity structurally: there is no
source `.version` for `cp -R` to carry, so the question never arises. `core/.gitignore`
lists it anyway, as cheap insurance against someone creating one by hand.

`hektor-triage-kit status` reports it, and `hektor-triage-kit --version` reports the
source's. An install predating this change has no `.version`; `status` says so in
those words rather than inventing one — "unknown (installed before the kit recorded
versions)" is the honest reading and distinguishes an old install from a broken one.

Not in scope, but worth recording because it is the obvious next use: forest's
provision record could carry the kit version alongside its inventory, which would
make its staleness detection version-aware instead of presence-based.

### 6. Consumption

```
npx /path/to/kits/flaky-triage-kit install --harness claude
npm i -g ./hektor-flaky-triage-1.0.0.tgz   &&   hektor-triage-kit install
```

and, if the package is ever published, `npx hektor-flaky-triage install` —
identical commands, different resolution.

**Every one of these forms reaches the CLI through a symlink.** That is how npm's
`bin` works and there is no opt-out: `<prefix>/bin/hektor-triage-kit` points at
`../lib/node_modules/hektor-flaky-triage/hektor-triage-kit` (relative), `npx` uses
`node_modules/.bin/`. bash puts the *symlink's* path in `BASH_SOURCE`, so the CLI
must walk the chain before taking `dirname` or `$HERE` lands in npm's bin directory
and `exec "$HERE/install.sh"` fails with rc 126 — every consumption path, silently
green in a source checkout where nothing is symlinked. macOS is bash 3.2 with BSD
readlink, so there is no `readlink -f` to lean on. A test invokes the CLI through a
two-hop chain with a relative outer hop; without it the resolution reads like
ceremony and gets tidied away.

`npx <tarball>` is **not** a supported form and is not advertised anywhere: npx
cannot resolve a `bin` from a tarball spec at all — it tries to execute the `.tgz`
and reports `Permission denied`. `npx <directory>` and `npm i -g <tarball>` are the
two forms that work.

### 7. Retiring the zip

`kits/flaky-triage-kit.zip` is deleted and `scripts/package-kit.sh` loses its
staging and zipping, keeping only the scan under its new name.

Maintaining two artifacts means one of them goes stale, and the one that went
stale is the one we have. The tarball is strictly better: versioned, checksummed,
manifest-carrying, and gated by the same scan.

This also disposes of the poisoned working-tree zip, which is otherwise a separate
thing to fix.

## What this does not do

- **It does not publish.** No registry, no `publishConfig`, no `npm publish` in any
  script. Publishing is a later, deliberate decision — and before it is taken, the
  hostname scan should be reviewed as a *publish* gate rather than a build gate,
  because a public registry is cached by mirrors and an unpublish window is narrow.
- **It does not change the CLI's behaviour.** `install`, `lock`, `unlock`,
  `status`, `link` are untouched; `build` is added beside them.
- **It does not thread a version through the engine's output.** `status` and
  `--version` report it (§5); no summary, verdict or ledger line carries it. That
  is a separate change with its own reasons.
- **It does not carry the pack.** The hektor pack's skills and hooks keep their own
  installer, as settled above.

## Testing

`core/tests/install-guard-test.sh` already owns the installer's `.lock-state`
rule and the packager's exclude; the packaging assertions belong beside them so a
reader fixing one meets the other.

1. `files` ships every path §2 names, from a staged fixture — proven by packing and
   listing, not by reading `package.json`.
2. `files` ships **none** of `core/.lock-state`, `.achilles/`, `.DS_Store`,
   `scripts/`, driven by planting each in a fixture.
3. `prepack` refuses when a hostname appears in a non-exempt file, and permits the
   two exempt ones — the existing `--self-test` behaviour, preserved under the new
   entrypoint.
4. `build` refuses from an installed kit with exit 66.
5. `build` removes the tarball and exits non-zero when verification fails — driven
   by planting a mismatched `install.sh` in a staged copy.
6. `npx <dir> install` reaches the CLI and passes arguments through. Verified
   already: `npx ./p install --harness claude` resolves a local bin and forwards
   `install --harness claude`.
7. `install.sh` writes `core/.version` carrying `package.json`'s version, proven
   by installing from a fixture whose `package.json` names a distinctive version
   and reading it back — not by asserting the literal the installer was handed.
8. `status` reports that version, and reports `unknown` for an install with no
   `.version` rather than inventing one or omitting the line. Both drivable
   without sudo, since `status` reads ownership and files only.
9. **The source tree carries no `core/.version`.** This is the structural
   guarantee that keeps §5's distinction from `.lock-state` true, so it is
   asserted rather than assumed: a `find` over the kit finds none, and installing
   twice from the same source produces two installs whose recorded instants
   differ — proving the record is written per-install, not copied.

Every assertion is proven by mutation: it must redden when the behaviour it names
is reverted. Five assertions in this repo's recent history shipped unable to fail,
and the `.lock-state` defect this spec's problem statement describes survived 1023
of them.

## Files

- Create: `kits/flaky-triage-kit/package.json`
- Modify: `kits/flaky-triage-kit/install.sh` (write `core/.version`, §5)
- Modify: `kits/flaky-triage-kit/core/.gitignore` (add `.version`, §5)
- Create: `kits/flaky-triage-kit/scripts/scan-kit.sh` (the scan, extracted)
- Modify: `kits/flaky-triage-kit/hektor-triage-kit` (the `build` subcommand + help)
- Modify: `kits/flaky-triage-kit/core/tests/install-guard-test.sh`
- Modify: `kits/flaky-triage-kit/README.md`, `kernel.md` (how to build and install)
- Delete: `kits/flaky-triage-kit/scripts/package-kit.sh`, `kits/flaky-triage-kit.zip`
