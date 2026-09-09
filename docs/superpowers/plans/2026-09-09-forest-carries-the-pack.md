# Forest Carries the Pack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forest ships the Hektor skill pack inside its own repo, provisions every worktree of a targeted repo automatically on both the Claude and Cursor axes, and refuses API requests that do not come from its own page.

**Architecture:** The pack is vendored at `packs/hektor` and becomes the default `packsDir`. A pure `autoSelections` helper turns the catalog's `targets` into the same selection shape the picker sends, and one `ensureProvisioned` step in the action handler is called from create, launch, task, the ticket route and a new provision route, skipping work when the pack's git tree hash has not changed. A request gate in front of every route checks Host, Origin and content type; a `managedPath` helper validates every path a mutating route acts on.

**Tech Stack:** Node built-ins only (`node:http`, `node:fs/promises`, `node:child_process`), `node --test`, vanilla browser JS in `public/`, bash for the pack's own installer. No npm dependencies, none may be added.

**Spec:** `docs/superpowers/specs/2026-09-09-forest-carries-the-pack-design.md`

## Global Constraints

- **The agent never commits.** Repo rule. Every task ends with `npm test` green and the diff left in the working tree; the user commits. Do not run `git commit`, `git add`, `git subtree`, or `git stash`.
- **No new dependencies.** `package.json` has no `dependencies` and must stay that way.
- **Node 20 or newer** is the floor the README states; the development machine runs Node 26. Use nothing newer than Node 20 supports.
- **Edit files with the Edit/Write tools, not shell redirection.** This checkout carries enforcement hooks under `.claude/hooks/` that block shell commands which write to paths matching hook, installer, or pipeline-state names. A heredoc into `lib/packs.mjs` or anything under `packs/` will be refused; the Edit and Write tools are the sanctioned path.
- **Copy rules:** `README.md` is written in Turkish; command lines, config keys, env var names, file names and the config table's key/env/default columns stay verbatim. Spec and plan stay in English. Journal lines and API error strings stay in English (the existing ones are).
- **Selection shape** everywhere is `{ pack, skills: [ids], kits: [ids], hooks: boolean }`, exactly what `public/app.js` `startSession()` sends today.
- **macOS only** for launching, unchanged.
- **Tests run with** `npm test` (all) or `node --test lib/<file>.test.mjs` (one file).

---

### Task 0: Vendor the pack (user-run, not agent-run)

This task is executed by the user because it creates commits. Every later task's tests use temporary packs under `os.tmpdir()`, so Tasks 1 to 11 do not depend on it. Task 12 (manual verification) does.

**Files:**
- Create: `packs/hektor/` (git subtree of `SKLS/hektor`)

- [ ] **Step 1: Commit the pack's pending refactor in SKLS**

The pack's working tree has 92 uncommitted entries (the Cursor-native refactor: deleted `adapters/`, modified gate scripts, deleted `settings.hooks.json`, new `hooks.json`). The subtree carries committed content only, so this must land first.

```bash
cd /Users/egecan.sen/sahibinden/repo/SKLS/hektor
printf '\n# achilles test scratch\n.achilles/\n' >> .gitignore   # keep the untracked run-summary.json out
git status --short | wc -l        # expect 92 before, 0 after
git add -A
git status --short | grep achilles   # must print nothing
git commit -m "pack: Cursor-native gates, hooks.json registrations, adapters folded into hooks/"
git checkout main && git merge --ff-only ft/kit-process-contract   # the two were already at the same commit
```

The pack repo has no remote and needs none: after Step 2 its history lives inside forest.

- [ ] **Step 2: Add the subtree to forest**

```bash
cd /Users/egecan.sen/sahibinden/repo/APPS/forest
git subtree add --prefix=packs/hektor /Users/egecan.sen/sahibinden/repo/SKLS/hektor main
ls packs/hektor/catalog.json packs/hektor/install.sh packs/hektor/hooks.json   # all three must exist
du -sh packs/hektor                                                              # about 2.5M; .claude/ .superpowers/ node_modules/ must NOT be present
```

- [ ] **Step 3: Drop the packsDir override from the local config**

`config.json` is gitignored and per machine. If it contains a `packsDir` line, delete that line so the new default (Task 1) applies. Restart forest afterwards: `forest restart`.

---

### Task 1: Config defaults — `packsDir` inside forest, `autoProvision` switch

**Files:**
- Modify: `lib/config.mjs:18-19` (DEFAULTS `packsDir`), add `autoProvision`
- Modify: `config.example.json`
- Test: `lib/config.test.mjs`

**Interfaces:**
- Produces: `DEFAULTS.packsDir === join(<forest dir>, 'packs')`; `DEFAULTS.autoProvision === true`. Later tasks read `ctx.config.autoProvision` and `ctx.config.packsDir`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/config.test.mjs`:

```js
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

test('packsDir defaults to forest\'s own packs/ directory, not a sibling SKLS', () => {
  const forestDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(DEFAULTS.packsDir, join(forestDir, 'packs'));
  assert.ok(!DEFAULTS.packsDir.includes('SKLS'));
});

test('autoProvision defaults to true and a config file can turn it off', async () => {
  assert.equal(mergeConfig({}).autoProvision, true);
  assert.equal(mergeConfig({ autoProvision: false }).autoProvision, false);
  const dir = await mkdtemp(join(tmpdir(), 'forest-cfg-'));
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ autoProvision: false }));
    assert.equal((await loadConfig(join(dir, 'config.json'))).autoProvision, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
```

(`join`, `mkdtemp`, `writeFile`, `rm`, `tmpdir`, `DEFAULTS`, `mergeConfig`, `loadConfig` are already imported at the top of that file; add only the two new imports above.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/config.test.mjs`
Expected: 2 failing — `packsDir` ends in `/SKLS`, `autoProvision` is `undefined`.

- [ ] **Step 3: Change the defaults**

In `lib/config.mjs`, replace the `packsDir` line and add `autoProvision` right after it:

```js
  // Skill packs ship INSIDE forest (packs/<id>/catalog.json + skills/ + kits/
  // + install.sh) so one clone carries the whole set. Override for a scratch
  // pack via config.json or FOREST_PACKS_DIR.
  packsDir: process.env.FOREST_PACKS_DIR || join(FOREST_DIR, 'packs'),
  // Provision worktrees of the repos a pack's catalog `targets` names, at
  // creation and on every launch, without the picker. The picker still
  // works with this off; only the automatic path stops.
  autoProvision: true,
```

Also update the comment two lines above the `roots` default that mentions SKLS, if any remains (`grep -n SKLS lib/config.mjs` must print nothing afterwards).

- [ ] **Step 4: Update the example config**

In `config.example.json`, delete the `"packsDir"` line and add `"autoProvision": true,` directly after the `"containers"` line. The file must stay valid JSON (`node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))"` prints nothing).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test lib/config.test.mjs`
Expected: all pass, including the existing `config.mjs source bakes in no personal path` test.

- [ ] **Step 6: Run the full suite; leave the diff in the working tree**

Run: `npm test`
Expected: all pass. Do not commit.

---

### Task 2: `packTargets` and `autoSelections` in `lib/packs.mjs`; catalog `targets`

**Files:**
- Modify: `lib/packs.mjs` (after `listPacks`, around line 30)
- Modify: `packs/hektor/catalog.json` (only if Task 0 has landed; otherwise `/Users/egecan.sen/sahibinden/repo/SKLS/hektor/catalog.json`)
- Test: `lib/packs.test.mjs`

**Interfaces:**
- Produces: `export function packTargets(cat) → string[]` and `export function autoSelections(packs, repoName) → [{ pack, skills, kits, hooks }]`. Task 7 and Task 10 import `autoSelections`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/packs.test.mjs` (add `packTargets, autoSelections` to the existing `import { … } from './packs.mjs'` line):

```js
const CAT = (over = {}) => ({
  pack: 'hektor',
  skillsets: [{ id: 'hektor-verify' }, { id: 'hektor-conventions' }],
  kits: [{ id: 'flaky-triage-kit' }],
  hooks: { id: 'hektor-gates', dir: 'hooks' },
  targets: ['web-test', 'test-data-client'],
  ...over,
});

test('autoSelections: a targeted repo gets the whole pack in picker shape', () => {
  assert.deepEqual(autoSelections([CAT()], 'web-test'), [
    { pack: 'hektor', skills: ['hektor-verify', 'hektor-conventions'], kits: ['flaky-triage-kit'], hooks: true },
  ]);
});

test('autoSelections: "*" targets every repo', () => {
  assert.equal(autoSelections([CAT({ targets: ['*'] })], 'forest').length, 1);
});

test('autoSelections: a repo the pack does not target gets nothing', () => {
  assert.deepEqual(autoSelections([CAT()], 'forest'), []);
});

test('autoSelections: no targets, an empty list, or a malformed value means picker-only', () => {
  assert.deepEqual(autoSelections([CAT({ targets: undefined })], 'web-test'), []);
  assert.deepEqual(autoSelections([CAT({ targets: [] })], 'web-test'), []);
  assert.deepEqual(autoSelections([CAT({ targets: 'web-test' })], 'web-test'), []);
  assert.deepEqual(packTargets({ targets: 'web-test' }), []);
  assert.deepEqual(packTargets({ targets: [' web-test ', 3, ''] }), ['web-test']);
});

test('autoSelections: hooks is false for a pack with no gate set, and ids that fail safeId are dropped', () => {
  const out = autoSelections([CAT({ hooks: undefined, skillsets: [{ id: 'ok' }, { id: '../evil' }], kits: [] })], 'web-test');
  assert.deepEqual(out, [{ pack: 'hektor', skills: ['ok'], kits: [], hooks: false }]);
});

test('autoSelections: no repo name means nothing', () => {
  assert.deepEqual(autoSelections([CAT()], ''), []);
  assert.deepEqual(autoSelections([CAT()], undefined), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/packs.test.mjs`
Expected: the six new tests fail with `packTargets is not a function` / `autoSelections is not a function`.

- [ ] **Step 3: Implement the helpers**

In `lib/packs.mjs`, directly after `listPacks`:

```js
// The repos a pack auto-provisions into, as forest names them (the repo
// directory's basename — see listRepoDirs / addRepoRecord in discover.mjs).
// Anything that is not an array of non-empty strings reads as "no targets":
// a malformed catalog makes a pack picker-only, never auto-installed.
export function packTargets(cat) {
  const t = cat && cat.targets;
  if (!Array.isArray(t)) return [];
  return t.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

// The automatic selection for a repo: every pack whose targets name it (or
// '*'), with ALL of its skills, kits and its gate set. Produces the exact
// shape the picker sends (see public/app.js startSession), so the provision
// record, the orphan guard and repair work on it unchanged — and because it
// is the whole pack, it is a superset of any earlier record and can never
// orphan a unit.
export function autoSelections(packs, repoName) {
  if (!repoName) return [];
  const out = [];
  for (const cat of packs || []) {
    const targets = packTargets(cat);
    if (!targets.includes('*') && !targets.includes(repoName)) continue;
    if (!safeId(cat.pack)) continue;
    out.push({
      pack: cat.pack,
      skills: (Array.isArray(cat.skillsets) ? cat.skillsets : []).map((s) => s && s.id).filter((id) => safeId(id)),
      kits: (Array.isArray(cat.kits) ? cat.kits : []).map((k) => k && k.id).filter((id) => safeId(id)),
      hooks: Boolean(cat.hooks),
    });
  }
  return out;
}
```

`safeId` is defined above `listPacks` in the same file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/packs.test.mjs`
Expected: all pass.

- [ ] **Step 5: Declare the pack's targets**

In the pack's `catalog.json` (at `packs/hektor/catalog.json` once Task 0 has landed, otherwise at `/Users/egecan.sen/sahibinden/repo/SKLS/hektor/catalog.json`), add after the `"description"` line:

```json
  "targets": ["web-test", "test-data-client"],
```

Check: `node -e "const c=require('/abs/path/catalog.json'); console.log(c.targets)"` prints `[ 'web-test', 'test-data-client' ]`.

- [ ] **Step 6: Run the full suite; leave the diff in the working tree**

Run: `npm test`
Expected: all pass. Do not commit.

---

### Task 3: `packFingerprint` — the pack's git tree hash, null when dirty or outside git

**Files:**
- Modify: `lib/packs.mjs` (after `autoSelections`)
- Test: `lib/packs.test.mjs`

**Interfaces:**
- Produces: `export async function packFingerprint(packsDir, pack, { now = Date.now(), ttlMs = 2000 } = {}) → string | null`. Task 7 calls it once per pack per provisioning request.

- [ ] **Step 1: Write the failing tests**

Append to `lib/packs.test.mjs` (add `packFingerprint` to the import line; `gitFixture` is already imported there):

```js
async function packInGit() {
  const root = await tmp('forest-fp-');
  await gitFixture(root, 'init', '-b', 'main');
  await gitFixture(root, 'config', 'user.email', 't@t');
  await gitFixture(root, 'config', 'user.name', 't');
  await gitFixture(root, 'config', 'gc.auto', '0');
  await mkdir(join(root, 'packs', 'hektor', 'skills', 's'), { recursive: true });
  await writeFile(join(root, 'packs', 'hektor', 'catalog.json'), '{"pack":"hektor"}\n');
  await writeFile(join(root, 'packs', 'hektor', 'skills', 's', 'SKILL.md'), '# s\n');
  await gitFixture(root, 'add', '.');
  await gitFixture(root, 'commit', '-m', 'pack');
  return root;
}
const treeHash = (root) => new Promise((res) => execFile('git', ['-C', root, 'rev-parse', 'HEAD:packs/hektor'], (e, out) => res(e ? null : String(out).trim())));

test('packFingerprint: a clean pack inside a git repo is its tree hash', async () => {
  const root = await packInGit();
  try {
    const fp = await packFingerprint(join(root, 'packs'), 'hektor', { now: 1, ttlMs: 0 });
    assert.match(fp, /^[0-9a-f]{40}$/);
    assert.equal(fp, await treeHash(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packFingerprint: an edited or untracked file makes the pack dirty → null (always provision)', async () => {
  const root = await packInGit();
  try {
    await writeFile(join(root, 'packs', 'hektor', 'skills', 's', 'SKILL.md'), '# edited\n');
    assert.equal(await packFingerprint(join(root, 'packs'), 'hektor', { now: 1, ttlMs: 0 }), null);
    await gitFixture(root, 'checkout', '--', '.');
    await writeFile(join(root, 'packs', 'hektor', 'skills', 's', 'NEW.md'), 'new\n');
    assert.equal(await packFingerprint(join(root, 'packs'), 'hektor', { now: 2, ttlMs: 0 }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packFingerprint: a pack outside any git repo, or a bad id, is null', async () => {
  const packs = await tmp('forest-fp-nogit-');
  try {
    await mkdir(join(packs, 'hektor'), { recursive: true });
    assert.equal(await packFingerprint(packs, 'hektor', { now: 1, ttlMs: 0 }), null);
    assert.equal(await packFingerprint(packs, '../x', { now: 1, ttlMs: 0 }), null);
  } finally { await rm(packs, { recursive: true, force: true }); }
});

test('packFingerprint: the answer is cached for ttlMs so a burst of launches forks git once', async () => {
  const root = await packInGit();
  try {
    const first = await packFingerprint(join(root, 'packs'), 'hektor', { now: 1000, ttlMs: 2000 });
    await writeFile(join(root, 'packs', 'hektor', 'skills', 's', 'SKILL.md'), '# edited\n');
    assert.equal(await packFingerprint(join(root, 'packs'), 'hektor', { now: 2500, ttlMs: 2000 }), first, 'inside the window: the cached hash');
    assert.equal(await packFingerprint(join(root, 'packs'), 'hektor', { now: 3001, ttlMs: 2000 }), null, 'after the window: recomputed, and dirty');
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

`tmp`, `mkdir`, `writeFile`, `rm`, `join`, `execFile` are already imported in that file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/packs.test.mjs`
Expected: 4 new failures, `packFingerprint is not a function`.

- [ ] **Step 3: Implement**

In `lib/packs.mjs`, after `autoSelections` (the module-private `git(cwd, args)` helper defined a few lines below `listPacks` returns the trimmed stdout, or `null` on any error):

```js
// What version of a pack is on disk, as one string a provision record can
// carry: the pack directory's git TREE hash, when the pack sits in a git repo
// and has no uncommitted change under it (edits, deletions, or untracked
// files — an untracked new skill counts, so it gets provisioned rather than
// waiting for a commit). Null otherwise, and null always means "provision":
// that is the developer's editing loop, and it must never be served stale.
//
// Cached per pack dir for `ttlMs`: launch, task and the guided notify can
// arrive within the same second for one worktree, and each would otherwise
// fork git three times.
const fingerprintCache = new Map(); // packDir -> { at, value }
export async function packFingerprint(packsDir, pack, { now = Date.now(), ttlMs = 2000 } = {}) {
  if (!packsDir || !safeId(pack)) return null;
  const packDir = join(packsDir, pack);
  const hit = fingerprintCache.get(packDir);
  if (hit && now - hit.at < ttlMs) return hit.value;
  let value = null;
  const top = await git(packDir, ['rev-parse', '--show-toplevel']);
  if (top) {
    const dirty = await git(packDir, ['status', '--porcelain', '--', '.']);
    if (dirty === '') {
      const rel = relative(top, packDir).split(sep).join('/');
      value = await git(top, ['rev-parse', rel ? `HEAD:${rel}` : 'HEAD^{tree}']);
    }
  }
  fingerprintCache.set(packDir, { at: now, value });
  return value;
}
```

Add `sep` to the existing `import { join, isAbsolute, dirname, basename, relative } from 'node:path';` line. Note `git()` resolves `''` (not `null`) for a clean `status --porcelain`, and `null` on error, so the `=== ''` check is exact.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/packs.test.mjs`
Expected: all pass.

- [ ] **Step 5: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 4: `copyTree` reports overwritten paths; `runSelections` journals them by name

**Files:**
- Modify: `lib/packs.mjs` (`copyTree`, `provisionKit`, `provisionPack`)
- Modify: `lib/actions.mjs` (`runSelections`, around line 199)
- Test: `lib/packs.test.mjs`, `lib/actions.test.mjs`

**Interfaces:**
- Produces: `copyTree(...)` returns `{ copied, updated, updatedPaths }` and accepts `updatedPaths: []` in its options; `provisionPack(...)` returns an additional `updated: [absolute paths]`; `runSelections` returns `updated` and journals one `refresh:` line when it is non-empty.

- [ ] **Step 1: Write the failing tests**

Append to `lib/packs.test.mjs`:

```js
test('copyTree with overwrite lists every path it replaced', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  try {
    await mkdir(join(src, 'lib'), { recursive: true });
    await writeFile(join(src, 'a.sh'), 'new a\n');
    await writeFile(join(src, 'lib', 'b.sh'), 'new b\n');
    await writeFile(join(src, 'same.sh'), 'same\n');
    await mkdir(join(dst, 'lib'), { recursive: true });
    await writeFile(join(dst, 'a.sh'), 'old a\n');
    await writeFile(join(dst, 'lib', 'b.sh'), 'old b\n');
    await writeFile(join(dst, 'same.sh'), 'same\n');
    const updatedPaths = [];
    const r = await copyTree(src, dst, { owner: 'pack', overwrite: true, updatedPaths });
    assert.equal(r.updated, 2);
    assert.deepEqual([...r.updatedPaths].sort(), [join(dst, 'a.sh'), join(dst, 'lib', 'b.sh')]);
    assert.equal(r.updatedPaths, updatedPaths, 'the caller\'s array is the one filled');
    assert.equal(await readFile(join(dst, 'a.sh'), 'utf8'), 'new a\n');
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});

test('provisionPack refresh returns the overwritten paths', async () => {
  const packs = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    await mkdir(join(packs, 'p', 'skills', 's'), { recursive: true });
    await writeFile(join(packs, 'p', 'skills', 's', 'SKILL.md'), '# v2\n');
    await mkdir(join(wt, '.claude', 'skills', 's'), { recursive: true });
    await writeFile(join(wt, '.claude', 'skills', 's', 'SKILL.md'), '# v1, edited locally\n');
    const r = await provisionPack({ packsDir: packs, pack: 'p', skills: ['s'], worktreePath: wt, refresh: true });
    assert.deepEqual(r.updated, [join(wt, '.claude', 'skills', 's', 'SKILL.md')]);
    assert.deepEqual(r.conflicts, []);
  } finally {
    await rm(packs, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});
```

Append to `lib/actions.test.mjs`:

```js
test('runSelections with refresh journals every overwritten file by name, capped at ten', async () => {
  const packsDir = await tmp('forest-packs-'), wt = await tmp('forest-wt-');
  try {
    await mkdir(join(packsDir, 'p', 'skills', 's'), { recursive: true });
    for (let i = 0; i < 12; i++) {
      await writeFile(join(packsDir, 'p', 'skills', 's', `f${String(i).padStart(2, '0')}.md`), 'new\n');
    }
    await mkdir(join(wt, '.claude', 'skills', 's'), { recursive: true });
    for (let i = 0; i < 12; i++) {
      await writeFile(join(wt, '.claude', 'skills', 's', `f${String(i).padStart(2, '0')}.md`), 'old\n');
    }
    const journal = [];
    const ctx = { config: { packsDir }, journal: { add: (e) => journal.push(e) } };
    const out = await runSelections({ ctx, path: wt, selections: [{ pack: 'p', skills: ['s'], kits: [], hooks: false }], mode: 'auto', refresh: true });
    assert.equal(out.updated.length, 12);
    const line = journal.find((e) => e.cmd.startsWith('refresh: overwrote 12 provisioned file(s)'));
    assert.ok(line, `expected a refresh line, got ${JSON.stringify(journal.map((e) => e.cmd))}`);
    assert.ok(line.cmd.includes('.claude/skills/s/f00.md'));
    assert.ok(line.cmd.endsWith('and 2 more'));
    assert.ok(!line.cmd.includes('f11.md'));
  } finally {
    await rm(packsDir, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/packs.test.mjs lib/actions.test.mjs`
Expected: 3 new failures (`updatedPaths` undefined; `r.updated` is a number, not an array; no refresh journal line).

- [ ] **Step 3: Implement in `lib/packs.mjs`**

`copyTree` signature and body:

```js
export async function copyTree(src, dest, { owner = 'unknown', conflicts = [], written = new Map(), overwrite = false, updatedPaths = [] } = {}) {
  let entries;
  try { entries = await readdir(src, { withFileTypes: true }); } catch { return { copied: 0, updated: 0, updatedPaths }; }
  await mkdir(dest, { recursive: true });
  let copied = 0;
  let updated = 0;
  for (const e of entries) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isDirectory()) {
      const r = await copyTree(from, to, { owner, conflicts, written, overwrite, updatedPaths });
      copied += r.copied;
      updated += r.updated;
      continue;
    }
    if (!e.isFile()) continue;
    const incoming = await readFile(from);
    let existing = null;
    try { existing = await readFile(to); } catch { /* absent — free to write */ }
    if (existing && sha(existing) !== sha(incoming)) {
      const other = written.get(to);
      if (!overwrite || (other && other !== owner)) {
        conflicts.push({ path: to, incoming: owner, existing: other || 'preexisting' });
        continue;
      }
      await copyFile(from, to);
      updated += 1;
      updatedPaths.push(to);   // named in the journal: a local edit was just replaced
    }
    if (!existing) {
      await copyFile(from, to);
      copied += 1;
    }
    await chmod(to, (await stat(from)).mode & 0o777);   // hooks must stay executable
    written.set(to, owner);
  }
  return { copied, updated, updatedPaths };
}
```

`provisionKit`: add `updatedPaths = []` to its destructured parameters and include it in `opts`:

```js
export async function provisionKit({ kitDir, kitId, worktreePath, conflicts, written, notes = [], refresh = false, updatedPaths = [] }) {
  const man = await readKitManifest(kitDir);
  const claudeDir = join(worktreePath, '.claude');
  const opts = { owner: kitId, conflicts, written, overwrite: refresh, updatedPaths };
```

`provisionPack`: add `updated: []` to `out`, thread it through `opts` and the kit call:

```js
  const out = { skills: [], kits: [], hooks: false, kitSkills: [], conflicts: [], notes: [], updated: [] };
  const written = new Map();
  const opts = (owner) => ({ owner, conflicts: out.conflicts, written, overwrite: refresh, updatedPaths: out.updated });
  …
    const r = await provisionKit({ kitDir: join(packDir, 'kits', id), kitId: id, worktreePath, conflicts: out.conflicts, written, notes: out.notes, refresh, updatedPaths: out.updated });
```

- [ ] **Step 4: Implement in `lib/actions.mjs`**

`runSelections` becomes:

```js
export async function runSelections({ ctx, path, selections, mode, refresh = false }) {
  const out = { skills: [], kits: [], hooks: false, conflicts: [], notes: [], updated: [] };
  for (const s of selections) {
    const r = await provisionPack({ packsDir: ctx.config.packsDir, pack: s.pack, skills: s.skills || [], kits: s.kits || [], hooks: !!s.hooks, worktreePath: path, refresh });
    out.skills.push(...r.skills);
    out.kits.push(...r.kits);
    out.conflicts.push(...r.conflicts);
    out.notes.push(...(r.notes || []));
    out.updated.push(...(r.updated || []));
    if (r.hooks) out.hooks = true;
  }
  for (const c of out.conflicts) {
    ctx.journal.add({ cmd: `collision: ${c.path} (${c.incoming} ≠ ${c.existing}) — kept existing`, cwd: path, mode });
  }
  // A refresh replaces files that differ from the pack. A teammate who edited
  // a provisioned skill or gate in this worktree just lost that edit; the
  // journal names what was replaced so it is visible, never silent.
  if (out.updated.length) {
    // Sorted: readdir order is not stable across filesystems, and the journal
    // line (and its test) must name the same first ten every time.
    const shown = [...out.updated].sort().slice(0, 10).map((p) => relative(path, p));
    const more = out.updated.length - shown.length;
    ctx.journal.add({ cmd: `refresh: overwrote ${out.updated.length} provisioned file(s): ${shown.join(', ')}${more ? ` and ${more} more` : ''}`, cwd: path, mode });
  }
  for (const n of out.notes) ctx.journal.add({ cmd: n, cwd: path, mode });
  return out;
}
```

Add `relative` to the `node:path` import at the top of `lib/actions.mjs` (currently `import { dirname, join, resolve } from 'node:path';`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test lib/packs.test.mjs lib/actions.test.mjs`
Expected: all pass, including the existing `copyTree` and `provisionPack` tests (return shape is a superset).

- [ ] **Step 6: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 5: Provision record carries `fingerprints` and `auto`

**Files:**
- Modify: `lib/packs.mjs:472` (`writeProvisionRecord`)
- Modify: `lib/actions.mjs` (`recordWithout` ~line 167; `wireCursorAxis` record rewrite ~line 373; remove-units writer ~line 1196)
- Test: `lib/packs.test.mjs`, `lib/actions.test.mjs`

**Interfaces:**
- Produces: `writeProvisionRecord(worktreePath, selections, inventory = null, at = null, cursor = null, extra = null)` where `extra` is `{ fingerprints?: { [pack]: string|null }, auto?: boolean }`. `recordWithout(record, units)` returns two more keys, `fingerprints` and `auto`, carried through unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `lib/packs.test.mjs`:

```js
test('writeProvisionRecord: fingerprints and auto are written when given and never invented', async () => {
  const wt = await tmp('forest-rec-');
  try {
    await writeProvisionRecord(wt, [{ pack: 'p', skills: ['s'], kits: [], hooks: false }], { kits: [], skills: ['s'] }, null, null,
      { fingerprints: { p: 'abc' }, auto: true });
    let rec = await readProvisionRecord(wt);
    assert.deepEqual(rec.fingerprints, { p: 'abc' });
    assert.equal(rec.auto, true);
    await writeProvisionRecord(wt, [{ pack: 'p', skills: ['s'], kits: [], hooks: false }]);
    rec = await readProvisionRecord(wt);
    assert.equal('fingerprints' in rec, false);
    assert.equal('auto' in rec, false);
  } finally { await rm(wt, { recursive: true, force: true }); }
});
```

Append to `lib/actions.test.mjs`:

```js
test('recordWithout carries fingerprints and auto through untouched', () => {
  const rec = { at: '2026-09-09T00:00:00.000Z', selections: [{ pack: 'p', skills: ['a', 'b'], kits: [], hooks: false }],
    inventory: { kits: [], skills: ['a', 'b'] }, fingerprints: { p: 'abc' }, auto: true };
  const next = recordWithout(rec, [{ kind: 'skill', id: 'b' }]);
  assert.deepEqual(next.fingerprints, { p: 'abc' });
  assert.equal(next.auto, true);
  assert.deepEqual(next.selections, [{ pack: 'p', skills: ['a'], kits: [], hooks: false }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/packs.test.mjs lib/actions.test.mjs`
Expected: 2 failures (`fingerprints` undefined on the record and on `next`).

- [ ] **Step 3: Implement**

`lib/packs.mjs`, `writeProvisionRecord`:

```js
export async function writeProvisionRecord(worktreePath, selections, inventory = null, at = null, cursor = null, extra = null) {
  const file = join(worktreePath, '.claude', PROVISION_FILE);
  await mkdir(dirname(file), { recursive: true });
  const rec = { at: typeof at === 'string' && at ? at : new Date().toISOString(), selections };
  if (inventory) rec.inventory = inventory;
  if (cursor) rec.cursor = cursor;
  // `fingerprints`: the pack tree hashes this record was provisioned from
  // (ensureProvisioned's skip rule reads them). `auto`: whether the selection
  // came from the catalog's targets or from the picker. Written only when
  // given, like `inventory` and `cursor`: a record that never had them must
  // not start claiming empty ones.
  if (extra && typeof extra === 'object') {
    if (extra.fingerprints && typeof extra.fingerprints === 'object') rec.fingerprints = extra.fingerprints;
    if (typeof extra.auto === 'boolean') rec.auto = extra.auto;
  }
  await writeFile(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}
```

`lib/actions.mjs`, `recordWithout` return object — add two keys after `cursor`:

```js
    cursor: record?.cursor ?? null,
    // Same reasoning as `cursor`: a removal changes neither which pack
    // version was provisioned nor whether the picker chose it.
    fingerprints: record?.fingerprints ?? null,
    auto: typeof record?.auto === 'boolean' ? record.auto : null,
```

`wireCursorAxis`, the record rewrite (currently `await writeProvisionRecord(path, rec.selections, rec.inventory ?? null, rec.at ?? null, { packs: packsNow, at: new Date().toISOString() });`) becomes:

```js
          await writeProvisionRecord(path, rec.selections, rec.inventory ?? null, rec.at ?? null,
            { packs: packsNow, at: new Date().toISOString() },
            { fingerprints: rec.fingerprints, auto: rec.auto });
```

The remove-units writer (currently `await writeProvisionRecord(path, next.selections, next.inventory, next.at, next.cursor);`) becomes:

```js
              await writeProvisionRecord(path, next.selections, next.inventory, next.at, next.cursor,
                { fingerprints: next.fingerprints, auto: next.auto });
```

(`auto: null` and `fingerprints: null` are ignored by the writer's type checks, so a record that never had them stays without them.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/packs.test.mjs lib/actions.test.mjs`
Expected: all pass, including `recordWithout carries the Cursor axis through untouched`.

- [ ] **Step 5: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 6: `managedPath` — every mutating route validates the path it acts on

**Files:**
- Modify: `lib/actions.mjs` (new exported helper near `findWorktree`; routes `/api/launch`, `/api/task`, `/api/open`, `/api/worktree/create`, `/api/worktree/remove`, `/api/worktree/repair`, `/api/tickets/worktrees`)
- Test: `lib/actions.test.mjs` (new tests + three fixture updates)

**Interfaces:**
- Produces: `export const PATH_ERROR = 'path is not a repo or worktree forest manages'`; `export async function managedPath(ctx, p) → { ok, kind: 'repo'|'worktree'|'pending'|'unverified', repoName, repoPath }`. Tasks 7 to 9 call it on every path they touch.

- [ ] **Step 1: Write the failing tests**

Append to `lib/actions.test.mjs` (add `managedPath, PATH_ERROR` to the `./actions.mjs` import; `basename` to the `node:path` import):

```js
function snapCtx({ repos = [], worktreeRoot = '/wtroot' } = {}) {
  const snap = { repos };
  return {
    config: { worktreeRoot, defaultMode: 'auto' },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => snap,
    cachedSnapshot: async () => snap,
  };
}
const REPO = { repo: 'web-test', repoPath: '/r/web-test', worktrees: [{ path: '/wtroot/web-test/tech-WEBT-1' }] };

test('managedPath: a listed repo, a listed worktree, and a pending path under worktreeRoot/<repo>/ are managed', async () => {
  const ctx = snapCtx({ repos: [REPO] });
  assert.deepEqual(await managedPath(ctx, '/r/web-test'), { ok: true, kind: 'repo', repoName: 'web-test', repoPath: '/r/web-test' });
  assert.deepEqual(await managedPath(ctx, '/wtroot/web-test/tech-WEBT-1'), { ok: true, kind: 'worktree', repoName: 'web-test', repoPath: '/r/web-test' });
  assert.deepEqual(await managedPath(ctx, '/wtroot/web-test/tech-WEBT-2'), { ok: true, kind: 'pending', repoName: 'web-test', repoPath: '/r/web-test' });
});

test('managedPath: anything else is refused — foreign dirs, traversal, a pending path for an unlisted repo, non-strings', async () => {
  const ctx = snapCtx({ repos: [REPO] });
  for (const p of ['/etc', '/wtroot/other-repo/x', '/wtroot/web-test/a/b', '/wtroot/web-test/../../etc', 'relative/path', '', null, 42]) {
    assert.equal((await managedPath(ctx, p)).ok, false, `must refuse ${JSON.stringify(p)}`);
  }
});

test('managedPath: a repo record without a name falls back to the directory basename', async () => {
  const ctx = snapCtx({ repos: [{ repoPath: '/r/test-data-client', worktrees: [] }] });
  assert.equal((await managedPath(ctx, '/r/test-data-client')).repoName, 'test-data-client');
  assert.equal((await managedPath(ctx, '/wtroot/test-data-client/x')).kind, 'pending');
});

test('managedPath: a ctx with no snapshot function (unit-test ctx only; server.mjs always provides one) is unverified but allowed', async () => {
  const r = await managedPath({ config: {} }, '/anything');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'unverified');
});

test('mutating routes refuse a path forest does not manage with a 400 and touch nothing', async () => {
  const ctx = snapCtx({ repos: [REPO] });
  let opened = 0;
  const handle = createActionHandler({ launch: async () => { opened++; return { ok: true }; } });
  const cases = [
    ['/api/launch', { path: '/etc', selections: [] }],
    ['/api/task', { path: '/etc', prompt: 'x', mode: 'guided' }],
    ['/api/open', { path: '/etc', target: 'finder' }],
    ['/api/worktree/create', { repoPath: '/etc', branch: 'b', newBranch: true, mode: 'auto' }],
    ['/api/worktree/remove', { repoPath: '/r/web-test', path: '/etc', mode: 'auto' }],
    ['/api/worktree/repair', { path: '/etc' }],
    ['/api/tickets/worktrees', { repoPath: '/etc', tickets: ['SHBDN-1'] }],
  ];
  for (const [url, body] of cases) {
    const res = fakeRes();
    await handle({ url }, res, ctx, async () => body);
    assert.equal(res.code, 400, `${url} must refuse`);
    assert.equal(JSON.parse(res.body).error, PATH_ERROR, url);
  }
  assert.equal(opened, 0);
  assert.equal(ctx.journal.entries.length, 0, 'a refused request journals nothing');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/actions.test.mjs`
Expected: failures — `managedPath is not a function`, and the routes answer 200/500 instead of 400.

- [ ] **Step 3: Implement the helper**

In `lib/actions.mjs`, directly after `findWorktree`:

```js
export const PATH_ERROR = 'path is not a repo or worktree forest manages';

// Every mutating route acts on a path from the request body. Before this
// check, that path could be anything on disk: with the cross-origin gap
// server.mjs closes in the same change, "anything" meant a web page could
// open a Terminal, run `claude -p`, or `git worktree remove --force`
// wherever it liked. A path is managed when it is a listed repo, a listed
// worktree, or exactly <worktreeRoot>/<repo>/<slug> for a listed repo (a
// worktree that exists on disk but is not in the snapshot yet, or is about to
// be created). Resolved first, so `..` cannot escape the root.
//
// `unverified`: a ctx with no `cachedSnapshot` at all. Only unit tests build
// such a ctx — server.mjs always passes one — and a check that silently
// passes in production would be worse than useless, so this branch is
// keyed on the ctx's SHAPE, which no request can influence.
export async function managedPath(ctx, p) {
  if (typeof ctx?.cachedSnapshot !== 'function') return { ok: true, kind: 'unverified', repoName: null, repoPath: null };
  if (typeof p !== 'string' || !p || !isAbsolute(p)) return { ok: false };
  const abs = resolve(p);
  const snap = await ctx.cachedSnapshot();
  const nameOf = (r) => r.repo ?? basename(r.repoPath);
  for (const r of snap?.repos || []) {
    if (resolve(r.repoPath) === abs) return { ok: true, kind: 'repo', repoName: nameOf(r), repoPath: r.repoPath };
    for (const w of r.worktrees || []) {
      if (w && w.path && resolve(w.path) === abs) return { ok: true, kind: 'worktree', repoName: nameOf(r), repoPath: r.repoPath };
    }
  }
  const root = ctx.config?.worktreeRoot ? resolve(ctx.config.worktreeRoot) : null;
  if (root && dirname(dirname(abs)) === root) {
    const repoName = basename(dirname(abs));
    const repo = (snap?.repos || []).find((r) => nameOf(r) === repoName);
    if (repo) return { ok: true, kind: 'pending', repoName, repoPath: repo.repoPath };
  }
  return { ok: false };
}
```

Extend the `node:path` import to `import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';`.

- [ ] **Step 4: Apply it to the routes**

Each route's first statement after destructuring the body. Use the 400 before any journal line or disk read.

`/api/worktree/create`:
```js
        const { repoPath, branch, base, newBranch } = body;
        const repoOk = await managedPath(ctx, repoPath);
        if (!repoOk.ok || (repoOk.kind !== 'repo' && repoOk.kind !== 'unverified')) return sendJson(res, { error: PATH_ERROR }, 400);
```

`/api/tickets/worktrees`:
```js
        const { repoPath, tickets = [], selections = [], boxes = [], prompt = '' } = body;
        const repoOk = await managedPath(ctx, repoPath);
        if (!repoOk.ok || (repoOk.kind !== 'repo' && repoOk.kind !== 'unverified')) return sendJson(res, { error: PATH_ERROR }, 400);
```

`/api/worktree/remove`:
```js
        const { repoPath, path, force, isPrimary } = body;
        if (isPrimary) return sendJson(res, { error: 'refusing to remove primary worktree' }, 400);
        if (!(await managedPath(ctx, repoPath)).ok || !(await managedPath(ctx, path)).ok) return sendJson(res, { error: PATH_ERROR }, 400);
```

`/api/worktree/repair`:
```js
        const { path } = body;
        if (!(await managedPath(ctx, path)).ok) return sendJson(res, { error: PATH_ERROR }, 400);
```

`/api/launch` (after the agent check, before `const sel = …`):
```js
        const managed = await managedPath(ctx, path);
        if (!managed.ok) return sendJson(res, { error: PATH_ERROR }, 400);
```

`/api/open`:
```js
        const { path, target } = body;
        if (!(await managedPath(ctx, path)).ok) return sendJson(res, { error: PATH_ERROR }, 400);
```

`/api/task` (after the agent check):
```js
        const managed = await managedPath(ctx, path);
        if (!managed.ok) return sendJson(res, { error: PATH_ERROR }, 400);
```

(`managed.repoName` is used by Tasks 7 and 8.)

- [ ] **Step 5: Update the three fixtures whose snapshots are empty**

These factories return `repos: []` while their tests act on real temp paths, so they would now be refused. Make each list what its tests use:

`ticketsCtx` (~line 1805) — list the repo:
```js
function ticketsCtx({ repo, wtRoot, packs } = {}, overrides = {}) {
  const snap = { repos: repo ? [{ repo: basename(repo), repoPath: repo, worktrees: [] }] : [] };
  return {
    config: { worktreeRoot: wtRoot, packsDir: packs || '/no/such/packs', openEditorCmd: 'open -a Cursor', defaultMode: 'auto', ...overrides },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => snap,
    cachedSnapshot: async () => snap,
  };
}
```

`cursorLaunchFixture` (~line 2481) — list the worktree:
```js
    snapshot: async () => ({ repos: [{ repo: 'wt', repoPath: '/r/wt', worktrees: [{ path: wt }] }] }),
    cachedSnapshot: async () => ({ repos: [{ repo: 'wt', repoPath: '/r/wt', worktrees: [{ path: wt }] }] }),
```

`repairFixture` (~line 2694) — same two lines with its own `wt`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test lib/actions.test.mjs`
Expected: all pass. If any other test now fails with `path is not a repo or worktree forest manages`, its ctx has a `cachedSnapshot` that omits the path it acts on: add the path to that fixture's snapshot the same way. Do not weaken `managedPath`.

- [ ] **Step 7: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 7: `unchangedSince` and `ensureProvisioned`; the `/api/worktree/provision` route

**Files:**
- Modify: `lib/actions.mjs` (new exported `unchangedSince` near `orphanedUnits`; new `ensureProvisioned` inside `createActionHandler` after `wireCursorAxis`; new route)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: `autoSelections`, `packFingerprint`, `listPacks` (Tasks 2, 3), `writeProvisionRecord(..., extra)` (Task 5), `managedPath` (Task 6), existing `runSelections`, `orphanedUnits`, `wireCursorAxis`, `packsWithInstaller`.
- Produces: `export function unchangedSince(record, sel, fingerprints, cursorPacks) → boolean`; handler-internal `ensureProvisioned({ ctx, path, repoName, selections = null, mode, reason, force = false })` resolving to one of `{ skipped }`, `{ blocked: 'orphaned-units', orphaned, repairable: false }`, `{ error }`, `{ provisioned, cursor, fingerprints, auto }`; `POST /api/worktree/provision { path }`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/actions.test.mjs` (add `unchangedSince` to the `./actions.mjs` import):

```js
test('unchangedSince: true only when every fingerprint matches, the record covers the selection, and the Cursor axis is recorded', () => {
  const sel = [{ pack: 'p', skills: ['a', 'b'], kits: ['k'], hooks: true }];
  const rec = { selections: sel, fingerprints: { p: 'abc' }, cursor: { packs: ['p'] } };
  assert.equal(unchangedSince(rec, sel, { p: 'abc' }, ['p']), true);
  assert.equal(unchangedSince(rec, sel, { p: 'abd' }, ['p']), false, 'pack changed');
  assert.equal(unchangedSince(rec, sel, { p: null }, ['p']), false, 'dirty pack never skips');
  assert.equal(unchangedSince({ ...rec, cursor: null }, sel, { p: 'abc' }, ['p']), false, 'cursor axis not wired yet');
  assert.equal(unchangedSince(rec, sel, { p: 'abc' }, []), true, 'no installer, nothing to wire');
  assert.equal(unchangedSince({ ...rec, selections: [{ pack: 'p', skills: ['a'], kits: ['k'], hooks: true }] }, sel, { p: 'abc' }, ['p']), false, 'record misses a skill');
  assert.equal(unchangedSince({ ...rec, selections: [{ pack: 'p', skills: ['a', 'b'], kits: ['k'], hooks: false }] }, sel, { p: 'abc' }, ['p']), false, 'record misses the gates');
  assert.equal(unchangedSince(null, sel, { p: 'abc' }, []), false);
});

// A pack in a git repo with targets, an installer that leaves a marker, and
// a worktree path under worktreeRoot/<repo>/ so managedPath reads it as
// pending. Everything ensureProvisioned touches, in one fixture.
async function autoFixture({ targets = ['web-test'], installer = true } = {}) {
  const root = await tmp('forest-auto-');
  await gitFixture(root, 'init', '-b', 'main');
  await gitFixture(root, 'config', 'user.email', 't@t');
  await gitFixture(root, 'config', 'user.name', 't');
  await gitFixture(root, 'config', 'gc.auto', '0');
  const packs = join(root, 'packs');
  await mkdir(join(packs, 'hektor', 'skills', 'hektor-verify'), { recursive: true });
  await writeFile(join(packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify\n');
  await writeFile(join(packs, 'hektor', 'catalog.json'), JSON.stringify({
    pack: 'hektor', targets, skillsets: [{ id: 'hektor-verify', label: 'Verify' }], kits: [],
  }));
  if (installer) {
    await writeFile(join(packs, 'hektor', 'install.sh'), '#!/bin/sh\nmkdir -p "$4/.cursor" && echo wired > "$4/.cursor/marker"\n');
    await chmod(join(packs, 'hektor', 'install.sh'), 0o755);
  }
  await gitFixture(root, 'add', '.');
  await gitFixture(root, 'commit', '-m', 'pack');
  const wtRoot = join(root, 'wt');
  const wt = join(wtRoot, 'web-test', 'tech-WEBT-1');
  await mkdir(wt, { recursive: true });
  const snap = { repos: [{ repo: 'web-test', repoPath: '/r/web-test', worktrees: [] }, { repo: 'forest', repoPath: '/r/forest', worktrees: [] }] };
  const ctx = {
    config: { packsDir: packs, worktreeRoot: wtRoot, defaultMode: 'auto', autoProvision: true },
    journal: { entries: [], add(e) { this.entries.push(e); } },
    broadcast() {},
    snapshot: async () => snap,
    cachedSnapshot: async () => snap,
  };
  return { root, packs, wt, wtRoot, ctx, cleanup: () => rm(root, { recursive: true, force: true }) };
}
// packFingerprint caches per pack dir for two seconds; a test that commits a
// pack change and provisions again inside that window would read the stale
// hash and wrongly skip. Every route test injects an uncached fingerprint.
const FRESH = (packsDir, pack) => packFingerprint(packsDir, pack, { ttlMs: 0 });
const provisionCall = (ctx, body) => {
  const res = fakeRes();
  return createActionHandler({ fingerprint: FRESH })({ url: '/api/worktree/provision' }, res, ctx, async () => body).then(() => res);
};

test('/api/worktree/provision: a targeted repo\'s worktree gets the whole pack on both axes, and a record with fingerprints and auto', async () => {
  const f = await autoFixture();
  try {
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(res.code, 200, res.body);
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true);
    assert.deepEqual(out.provisioned.skills, ['hektor-verify']);
    assert.deepEqual(out.cursor.wired, ['hektor']);
    assert.equal(out.auto, true);
    assert.match(out.fingerprints.hektor, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    assert.equal(await readFile(join(f.wt, '.cursor', 'marker'), 'utf8'), 'wired\n');
    const rec = await readProvisionRecord(f.wt);
    assert.equal(rec.auto, true);
    assert.equal(rec.fingerprints.hektor, out.fingerprints.hektor);
    assert.deepEqual(rec.cursor.packs, ['hektor']);
    assert.ok(f.ctx.journal.entries.some((e) => e.cmd.startsWith('provision (provision): 1 skill(s)')));
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: the second call with an unchanged pack is skipped and journals nothing', async () => {
  const f = await autoFixture();
  try {
    await provisionCall(f.ctx, { path: f.wt });
    const before = f.ctx.journal.entries.length;
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(JSON.parse(res.body).skipped, 'unchanged');
    assert.equal(f.ctx.journal.entries.length, before);
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: a pack edit after the first call provisions again with refresh and names the overwritten file', async () => {
  const f = await autoFixture();
  try {
    await provisionCall(f.ctx, { path: f.wt });
    await writeFile(join(f.packs, 'hektor', 'skills', 'hektor-verify', 'SKILL.md'), '# verify v2\n');
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'v2');
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(JSON.parse(res.body).provisioned.skills.length, 1);
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify v2\n');
    assert.ok(f.ctx.journal.entries.some((e) => e.cmd.includes('refresh: overwrote 1 provisioned file(s): .claude/skills/hektor-verify/SKILL.md')));
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: a dirty pack (null fingerprint) provisions every time', async () => {
  const f = await autoFixture();
  try {
    await writeFile(join(f.packs, 'hektor', 'skills', 'hektor-verify', 'NOTES.md'), 'untracked\n');
    await provisionCall(f.ctx, { path: f.wt });
    const res = await provisionCall(f.ctx, { path: f.wt });
    const out = JSON.parse(res.body);
    assert.equal(out.skipped, undefined);
    assert.equal(out.fingerprints.hektor, null);
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: a repo the pack does not target gets nothing', async () => {
  const f = await autoFixture({ targets: ['test-data-client'] });
  try {
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(JSON.parse(res.body).skipped, 'nothing to provision');
    await assert.rejects(stat(join(f.wt, '.claude')));
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: autoProvision: false skips the automatic path', async () => {
  const f = await autoFixture();
  try {
    f.ctx.config.autoProvision = false;
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(JSON.parse(res.body).skipped, 'autoProvision off');
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: the automatic selection never orphans a unit from an earlier partial record', async () => {
  const f = await autoFixture();
  try {
    await writeProvisionRecord(f.wt, [{ pack: 'hektor', skills: ['hektor-verify'], kits: [], hooks: false }], { kits: [], skills: ['hektor-verify'] });
    const res = await provisionCall(f.ctx, { path: f.wt });
    assert.equal(JSON.parse(res.body).blocked, undefined);
    assert.equal(JSON.parse(res.body).ok, true);
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: a path that is not managed is a 400; a managed path that does not exist yet is a 409', async () => {
  const f = await autoFixture();
  try {
    let res = await provisionCall(f.ctx, { path: '/etc' });
    assert.equal(res.code, 400);
    res = await provisionCall(f.ctx, { path: join(f.wtRoot, 'web-test', 'not-yet') });
    assert.equal(res.code, 409);
    assert.equal(JSON.parse(res.body).error, 'worktree directory does not exist yet');
  } finally { await f.cleanup(); }
});

test('/api/worktree/provision: an installer failure is reported and journaled, the Claude axis still lands', async () => {
  const f = await autoFixture();
  try {
    await writeFile(join(f.packs, 'hektor', 'install.sh'), '#!/bin/sh\necho boom >&2; exit 3\n');
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'broken installer');
    const res = await provisionCall(f.ctx, { path: f.wt });
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true);
    assert.match(out.cursor.error, /install\.sh --harness cursor failed \(exit 3\): boom/);
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    assert.ok(f.ctx.journal.entries.some((e) => e.cmd.includes('cursor adapter NOT wired')));
  } finally { await f.cleanup(); }
});
```

`readProvisionRecord`, `writeProvisionRecord`, `stat`, `chmod`, `readFile` and `gitFixture` are already imported in that file; add `packFingerprint` to the `./packs.mjs` import line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/actions.test.mjs`
Expected: `unchangedSince is not a function`; the provision route answers `404 unknown action`.

- [ ] **Step 3: Implement `unchangedSince`**

In `lib/actions.mjs`, directly after `orphanedUnits`:

```js
// Can a launch skip provisioning this worktree? Only when all three hold:
// every selected pack's current fingerprint is non-null and equals the
// record's; every pack, skill id, kit id and hooks flag in the selection is
// present in the record's selections; and the record's Cursor axis names
// every selected pack that ships an install.sh. Pure.
export function unchangedSince(record, sel, fingerprints, cursorPacks = []) {
  if (!record || !Array.isArray(record.selections)) return false;
  const recFp = record.fingerprints || {};
  const has = (arr, id) => Array.isArray(arr) && arr.includes(id);
  for (const s of sel) {
    const fp = fingerprints[s.pack];
    if (!fp || recFp[s.pack] !== fp) return false;
    const rec = record.selections.find((r) => r && r.pack === s.pack);
    if (!rec) return false;
    for (const id of s.skills || []) if (!has(rec.skills, id)) return false;
    for (const id of s.kits || []) if (!has(rec.kits, id)) return false;
    if (s.hooks && !rec.hooks) return false;
  }
  const wired = Array.isArray(record.cursor?.packs) ? record.cursor.packs : [];
  for (const p of cursorPacks) if (!wired.includes(p)) return false;
  return true;
}
```

- [ ] **Step 4: Implement `ensureProvisioned`**

Add to the imports at the top of `lib/actions.mjs`: `listPacks, autoSelections, packFingerprint` in the `./packs.mjs` import line.

Add `fingerprint = packFingerprint,` to `createActionHandler`'s destructured options (after `launch = launchInteractive,`), following the file's injection convention; tests pass an uncached one.

Inside `createActionHandler`, directly after `wireCursorAxis`:

```js
  // The one provisioning step (spec §4). Called from worktree creation, the
  // guided-mode notify route, launch, task and the ticket route, so a
  // worktree is provisioned the same way whichever door it came through.
  // `selections`: an array means the picker chose (explicit, honoured even
  // with autoProvision off); null means the catalog's targets decide.
  // Never throws — a worktree or a session was asked for, not a gate; every
  // failure is a value plus a journal line.
  async function ensureProvisioned({ ctx, path, repoName, selections = null, mode, reason, force = false }) {
    const packsDir = ctx.config.packsDir;
    const explicit = Array.isArray(selections);
    if (!explicit && ctx.config.autoProvision === false) return { skipped: 'autoProvision off' };
    let sel;
    if (explicit) {
      sel = selections.filter((s) => s && s.pack && ((s.skills?.length) || (s.kits?.length) || s.hooks));
    } else {
      sel = packsDir ? autoSelections(await listPacks(packsDir), repoName) : [];
    }
    const auto = !explicit;
    if (!sel.length) return { skipped: 'nothing to provision', auto };

    // The orphan guard, unchanged and in the same place it always was: read
    // AND enforce before anything is written, so a blocked call mutates
    // nothing. Unreachable for the automatic selection (a superset of any
    // record), which the tests assert.
    const previous = await readProvisionRecord(path).catch(() => null);
    const orphaned = orphanedUnits(previous, sel);
    if (orphaned.length && !force) {
      ctx.journal.add({ cmd: `launch blocked: ${orphaned.length} provisioned unit(s) no longer selected (${orphaned.map((o) => o.id).join(', ')})`, cwd: path, mode });
      return { blocked: 'orphaned-units', orphaned, repairable: false };
    }

    const fingerprints = {};
    for (const s of sel) fingerprints[s.pack] = await fingerprint(packsDir, s.pack);
    const cursorPacks = await packsWithInstaller(packsDir, sel.map((s) => s.pack));
    if (unchangedSince(previous, sel, fingerprints, cursorPacks)) {
      return { skipped: 'unchanged', fingerprints, auto };
    }

    let provisioned;
    try {
      provisioned = await runSelections({ ctx, path, selections: sel, mode, refresh: true });
      await writeProvisionRecord(path, sel, { kits: provisioned.kits, skills: provisioned.skills }, null, previous?.cursor ?? null, { fingerprints, auto });
    } catch (e) {
      ctx.journal.add({ cmd: `provision failed (${reason}): ${e?.message || e}`, cwd: path, mode });
      return { error: `provision failed: ${e?.message || e}` };
    }
    // Both axes, whichever agent is or is not launching: cursor-agent reads
    // .cursor/ only, and a worktree opened from a plain terminal must find it.
    let cursor = null;
    if (cursorPacks.length) {
      const w = await wireCursorAxis({ ctx, path, packs: cursorPacks, mode, label: worktreeTitle(path) });
      cursor = { wired: w.wired, ...(w.error ? { error: w.error } : {}) };
    }
    const n = provisioned.skills.length, k = provisioned.kits.length;
    ctx.journal.add({
      cmd: `provision (${reason}): ${n} skill(s)${k ? `, ${k} kit(s)` : ''}${provisioned.hooks ? ', gates' : ''} → .claude/`
        + (cursor ? `; .cursor/ ${cursor.error ? 'NOT wired' : 'wired'}` : ''),
      cwd: path, mode,
    });
    return { provisioned, cursor, fingerprints, auto };
  }
```

- [ ] **Step 5: Add the route**

In `handleAction`, directly before `if (url === '/api/worktree/repair')`:

```js
      // The guided-mode notify (the Terminal's `git worktree add … && curl`
      // lands here once git has exited 0), and a hand-run provision. Idempotent.
      if (url === '/api/worktree/provision') {
        const { path } = body;
        const managed = await managedPath(ctx, path);
        if (!managed.ok) return sendJson(res, { error: PATH_ERROR }, 400);
        const isDir = await stat(path).then((s) => s.isDirectory(), () => false);
        if (!isDir) return sendJson(res, { error: 'worktree directory does not exist yet' }, 409);
        const p = await ensureProvisioned({ ctx, path, repoName: managed.repoName, mode, reason: 'provision' });
        if (p.error) return sendJson(res, { error: p.error }, 500);
        if (p.blocked) return sendJson(res, { ok: false, ...p });
        return sendJson(res, { ok: true, ...p });
      }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test lib/actions.test.mjs`
Expected: all pass.

- [ ] **Step 7: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 8: `/api/launch` and `/api/task` go through `ensureProvisioned`

**Files:**
- Modify: `lib/actions.mjs` (`/api/launch` ~lines 1329-1400, `/api/task` ~line 1463)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: `ensureProvisioned`, `managedPath` (Tasks 6, 7).
- Produces: `/api/launch` response keeps `ok, action, agent, provisioned, promptSent, scope, cursorAdapter?` and adds `provision: { skipped?, auto, fingerprints? }`. A launch body without a `selections` key uses the automatic selection. `/api/task` response is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `lib/actions.test.mjs`:

```js
test('/api/launch without a selections key provisions the automatic selection on both axes, then launches', async () => {
  const f = await autoFixture();
  try {
    const seen = [];
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; }, resolveScope: noRealHome })(
      { url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude' }));
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true, res.body);
    assert.equal(out.provision.auto, true);
    assert.deepEqual(out.provisioned.skills, ['hektor-verify']);
    assert.equal(await readFile(join(f.wt, '.cursor', 'marker'), 'utf8'), 'wired\n', 'a CLAUDE launch still wires the Cursor axis');
    assert.equal(seen.length, 1);
  } finally { await f.cleanup(); }
});

test('/api/launch with an explicit selection provisions exactly that and records auto: false', async () => {
  const f = await autoFixture();
  try {
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => ({ ok: true, action: 'launched', agent: a.agent }), resolveScope: noRealHome })(
      { url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'cursor', selections: [{ pack: 'hektor', skills: ['hektor-verify'], kits: [], hooks: false }] }));
    assert.equal(JSON.parse(res.body).provision.auto, false);
    assert.equal((await readProvisionRecord(f.wt)).auto, false);
  } finally { await f.cleanup(); }
});

test('/api/launch with selections: [] (the missing-hooks retry) provisions nothing and still launches', async () => {
  const f = await autoFixture();
  try {
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => ({ ok: true, action: 'launched', agent: a.agent }), resolveScope: noRealHome })(
      { url: '/api/launch' }, res, f.ctx, async () => ({ path: f.wt, agent: 'claude', selections: [], force: true }));
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true);
    assert.equal(out.provision.skipped, 'nothing to provision');
    await assert.rejects(stat(join(f.wt, '.claude')));
  } finally { await f.cleanup(); }
});

test('/api/task provisions the automatic selection before opening the Terminal', async () => {
  const f = await autoFixture();
  try {
    const seen = [];
    const res = fakeRes();
    await createActionHandler({ launch: async (a) => { seen.push(a); return { ok: true, action: 'launched', agent: a.agent }; } })(
      { url: '/api/task' }, res, f.ctx, async () => ({ path: f.wt, mode: 'guided', agent: 'cursor', prompt: 'x' }));
    assert.deepEqual(JSON.parse(res.body), { mode: 'guided', agent: 'cursor' });
    assert.equal(await readFile(join(f.wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    const idx = f.ctx.journal.entries.findIndex((e) => e.cmd.startsWith('provision (task)'));
    assert.ok(idx >= 0);
    assert.ok(idx < f.ctx.journal.entries.length - 1, 'provisioning is journaled before the launch line');
  } finally { await f.cleanup(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/actions.test.mjs`
Expected: 4 failures (`provision` undefined on the response; `.cursor/marker` absent on a Claude launch; no `provision (task)` line).

- [ ] **Step 3: Rewrite the provisioning section of `/api/launch`**

Replace everything in the `/api/launch` block from `const sel = selections.filter(…)` through the end of the `if (agent === 'cursor' && sel.length) { … }` Cursor block (i.e. up to, not including, the `// Claude only: launchDecision …` comment) with:

```js
        // `selections` present (the picker, or a retry) is explicit and
        // honoured as-is — `[]` on the missing-hooks retry means "provision
        // nothing", exactly as before. Absent means the catalog's targets
        // decide. Orphan guard, fingerprint skip, record write and BOTH axes
        // live inside ensureProvisioned.
        const p = await ensureProvisioned({
          ctx, path, repoName: managed.repoName, selections: body.selections === undefined ? null : selections,
          mode, reason: 'launch', force: !!body.force,
        });
        if (p.blocked) return sendJson(res, { ok: false, ...p });
        if (p.error) return sendJson(res, { error: p.error }, 500);
        const provisioned = p.provisioned ?? null;
        const cursorAdapter = p.cursor?.error ? { error: p.cursor.error } : null;
        const provision = { auto: p.auto ?? false, ...(p.skipped ? { skipped: p.skipped } : {}), ...(p.fingerprints ? { fingerprints: p.fingerprints } : {}) };
```

(`managed` is the `managedPath` result Task 6 added at the top of the route; `selections` is the body's destructured array, default `[]`.) Then include `provision` in the success response object: after `provisioned,` add `provision,`. Delete the now-unused `sel` variable if nothing else in the block references it.

- [ ] **Step 4: Add the step to `/api/task`**

After the `managedPath` check Task 6 added, before `const cmds = agentCmds(ctx.config);`:

```js
        await ensureProvisioned({ ctx, path, repoName: managed.repoName, mode, reason: 'task' });
```

The response bodies stay exactly as they are (a test pins `{ mode: 'guided', agent }`).

- [ ] **Step 5: Run the tests; update the Cursor-axis assertions the spec changed**

Run: `node --test lib/actions.test.mjs`
Expected: the four new tests pass. Tests in the `cursorLaunchFixture` block that assert a **Claude** launch leaves `.cursor/` alone, or that install.sh runs only for `agent: 'cursor'`, now fail: the spec wires both axes for every launch. For each such test, invert the assertion (the installer runs for a Claude launch too) and rename the test to say so, e.g. `/api/launch: a Claude launch wires the Cursor axis as well`. Do not change any test that asserts the record, the journal wording, or the `cursorAdapter` error shape.

- [ ] **Step 6: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 9: Provision at creation (auto and guided) and in the ticket route

**Files:**
- Modify: `lib/actions.mjs` (`createActionHandler` options; `dispatchGit` ~line 441; `createWorktreeAt` ~line 466; `/api/worktree/create` ~line 705; `ensureTicketWorktree` ~lines 626-700; delete `CURSOR_ADAPTER_SKILLS` / `hektorAdapterPack` ~lines 236-245)
- Test: `lib/actions.test.mjs`

**Interfaces:**
- Consumes: `ensureProvisioned`, `managedPath`.
- Produces: `createActionHandler({ runTerminal = runInTerminal })` injectable; `export function provisionNotifyCommand({ port, path }) → string`; `/api/worktree/create` auto-mode response gains `provision`, guided-mode response gains `provisioning: 'on first launch or when the Terminal command finishes'`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/actions.test.mjs` (add `provisionNotifyCommand` to the `./actions.mjs` import):

```js
test('provisionNotifyCommand posts the worktree path back to forest as JSON, shell-quoted', () => {
  const cmd = provisionNotifyCommand({ port: 5577, path: "/Users/me/.forest/wt/web-test/it's" });
  assert.equal(cmd, `curl -s -X POST -H 'content-type: application/json' --data '{"path":"/Users/me/.forest/wt/web-test/it'\\''s"}' http://127.0.0.1:5577/api/worktree/provision`);
});

test('/api/worktree/create auto: the new worktree is provisioned before the response returns', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  const f = await autoFixture();
  try {
    const ctx = ticketsCtx({ repo, wtRoot, packs: f.packs });
    ctx.config.autoProvision = true;
    // Target the fixture repo by its directory name.
    await writeFile(join(f.packs, 'hektor', 'catalog.json'), JSON.stringify({
      pack: 'hektor', targets: [basename(repo)], skillsets: [{ id: 'hektor-verify', label: 'Verify' }], kits: [],
    }));
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'retarget');
    const res = fakeRes();
    await createActionHandler()({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-9', newBranch: true, mode: 'auto',
    }));
    const out = JSON.parse(res.body);
    assert.equal(out.mode, 'auto');
    assert.deepEqual(out.provision.provisioned.skills, ['hektor-verify']);
    const wt = join(wtRoot, basename(repo), 'tech-WEBT-9');
    assert.equal(await readFile(join(wt, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    assert.equal(await readFile(join(wt, '.cursor', 'marker'), 'utf8'), 'wired\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
    await f.cleanup();
  }
});

test('/api/worktree/create guided: the Terminal command ends with the provision notify, and nothing is provisioned yet', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  try {
    const ctx = ticketsCtx({ repo, wtRoot }, { port: 5599 });
    const seen = [];
    const res = fakeRes();
    await createActionHandler({ runTerminal: async (a) => { seen.push(a); return { ok: true }; } })({ url: '/api/worktree/create' }, res, ctx, async () => ({
      repoPath: repo, branch: 'tech/WEBT-9', newBranch: true, mode: 'guided',
    }));
    const out = JSON.parse(res.body);
    assert.equal(out.mode, 'guided');
    assert.equal(out.provisioning, 'on first launch or when the Terminal command finishes');
    assert.equal(seen.length, 1);
    const wt = join(wtRoot, basename(repo), 'tech-WEBT-9');
    assert.ok(seen[0].command.startsWith("git 'worktree' 'add'"), seen[0].command);
    assert.ok(seen[0].command.endsWith(` && ${provisionNotifyCommand({ port: 5599, path: wt })}`), seen[0].command);
    await assert.rejects(stat(wt), 'guided mode runs git in the Terminal, not here');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
  }
});

test('/api/tickets/worktrees: with no selections the ticket worktree gets the automatic selection on both axes', async () => {
  const { repo, wtRoot } = await bareRepoFixture();
  const f = await autoFixture();
  try {
    await writeFile(join(f.packs, 'hektor', 'catalog.json'), JSON.stringify({
      pack: 'hektor', targets: [basename(repo)], skillsets: [{ id: 'hektor-verify', label: 'Verify' }], kits: [],
    }));
    await gitFixture(f.root, 'add', '.');
    await gitFixture(f.root, 'commit', '-m', 'retarget');
    const ctx = ticketsCtx({ repo, wtRoot, packs: f.packs });
    const res = fakeRes();
    await createActionHandler({
      inferBranchPrefix: async () => 'tech/WEBT-',
      openCursorWorkspace: async () => ({ cli: true, ok: true, workspaceFile: '/x', foldersAdded: 1, briefsOpened: 0 }),
      fetchIssueDetail: async () => ({ error: 'offline' }),
    })({ url: '/api/tickets/worktrees' }, res, ctx, async () => ({ repoPath: repo, tickets: ['SHBDN-7'] }));
    const out = JSON.parse(res.body);
    assert.equal(out.ok, true, res.body);
    const r = out.results[0];
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(await readFile(join(r.path, '.claude', 'skills', 'hektor-verify', 'SKILL.md'), 'utf8'), '# verify\n');
    assert.equal(await readFile(join(r.path, '.cursor', 'marker'), 'utf8'), 'wired\n');
    assert.equal((await readProvisionRecord(r.path)).auto, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wtRoot, { recursive: true, force: true });
    await f.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/actions.test.mjs`
Expected: `provisionNotifyCommand is not a function`; the create responses lack `provision` / `provisioning`; the ticket worktree has no `.claude/`.

- [ ] **Step 3: Implement the notify command and the injectable terminal runner**

In `lib/actions.mjs`, after `originOf`:

```js
// The clause appended to the guided-mode `git worktree add` line so the
// Terminal tells forest when git has exited 0 — provisioning then starts
// on a checkout that is complete, never one still being written. curl sends
// no Origin, so the request gate admits it on the Host check alone.
export function provisionNotifyCommand({ port, path }) {
  return `curl -s -X POST -H 'content-type: application/json' --data ${shQuote(JSON.stringify({ path }))} http://127.0.0.1:${port}/api/worktree/provision`;
}
```

In `createActionHandler`'s options add `runTerminal = runInTerminal,` (after `launch = launchInteractive,`). Change `dispatchGit`:

```js
  // `after`: an already-quoted shell clause run only if git exits 0
  // (guided mode only — in auto mode the caller does that work itself).
  async function dispatchGit({ cwd, args, mode, ctx, after = null }) {
    const command = `git ${args.map(shQuote).join(' ')}${after ? ` && ${after}` : ''}`;
    ctx.journal.add({ cmd: command, cwd, mode });
    if (mode === 'guided') {
      runTerminal({ command, cwd, app: ctx.config.terminalApp });
      return { mode, command };
    }
    const out = await runGit(cwd, args);
    ctx.broadcast('worktrees', await ctx.snapshot());
    return { mode, command, output: out };
  }
```

`createWorktreeAt` passes the clause through in guided mode:

```js
  async function createWorktreeAt({ repoPath, branch, base, newBranch, mode, ctx }) {
    const wtPath = worktreePathFor({ worktreeRoot: ctx.config.worktreeRoot, repoPath, branchSlug: slug(branch) });
    await mkdir(dirname(wtPath), { recursive: true });
    const startPoint = base || await safeBaseBranch(repoPath);
    const args = newBranch
      ? ['worktree', 'add', '-b', branch, wtPath, startPoint]
      : ['worktree', 'add', wtPath, branch];
    const after = mode === 'guided' && ctx.config.autoProvision !== false
      ? provisionNotifyCommand({ port: ctx.config.port || 5577, path: wtPath })
      : null;
    const result = await dispatchGit({ cwd: repoPath, args, mode, ctx, after });
    return { wtPath, result };
  }
```

(Keep the existing explanatory comment about the base branch above `startPoint`.)

- [ ] **Step 4: Provision in the create route**

```js
      if (url === '/api/worktree/create') {
        const { repoPath, branch, base, newBranch } = body;
        const repoOk = await managedPath(ctx, repoPath);
        if (!repoOk.ok || (repoOk.kind !== 'repo' && repoOk.kind !== 'unverified')) return sendJson(res, { error: PATH_ERROR }, 400);
        const { wtPath, result } = await createWorktreeAt({ repoPath, branch, base, newBranch, mode, ctx });
        if (mode === 'guided') {
          return sendJson(res, { ...result, provisioning: 'on first launch or when the Terminal command finishes' });
        }
        const provision = await ensureProvisioned({ ctx, path: wtPath, repoName: basename(repoPath), mode, reason: 'create' });
        return sendJson(res, { ...result, provision });
      }
```

- [ ] **Step 5: Replace the ticket route's selection block**

In `ensureTicketWorktree`, replace the whole `if (selections && selections.length) { … }` block (the `runSelections` + `writeProvisionRecord` try, and the `hektorAdapterPack` / `wireCursorAxis` call) with:

```js
    // Explicit when the modal sent a saved selection, automatic otherwise.
    // Both axes either way — the whole point of a ticket worktree is a
    // Cursor window on it.
    const p = await ensureProvisioned({
      ctx, path: wtPath, repoName: basename(repoPath),
      selections: selections && selections.length ? selections : null,
      mode: 'auto', reason: 'ticket',
    });
    if (p.error) out.provisionError = p.error;
    if (p.cursor?.error) out.cursorAdapterError = p.cursor.error;
```

Delete `CURSOR_ADAPTER_SKILLS` and `hektorAdapterPack` (nothing else references them: `grep -n hektorAdapterPack lib/` must print nothing afterwards).

- [ ] **Step 6: Run the tests; update the ticket-route assertions the spec changed**

Run: `node --test lib/actions.test.mjs`
Expected: the four new tests pass. Existing `/api/tickets/worktrees` tests that assert install.sh runs **only** when `hektor-multi-ticket` or `hektor-from-jira` is selected now fail: with an explicit selection the installer runs for every selected pack that ships one; with none, for every auto-targeted pack. Invert those assertions and rename the tests accordingly. Tests that pass a `packs` dir without a catalog and no selections see `skipped: 'nothing to provision'` and must keep passing unchanged.

- [ ] **Step 7: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 10: Request gate in front of every route; `/api/packs?repo=`; startup targets check

**Files:**
- Create: `lib/request-gate.mjs`
- Create: `lib/request-gate.test.mjs`
- Modify: `server.mjs` (gate before routing; `/api/packs`; startup journal)

**Interfaces:**
- Produces: `export function gateRequest(req, { port, srpOrigin = null }) → { ok: true } | { ok: false, status: 403|415, reason }`. `GET /api/packs?repo=<name>` returns `{ packs, auto }`.

- [ ] **Step 1: Write the failing tests**

Create `lib/request-gate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateRequest } from './request-gate.mjs';

const req = (over = {}) => ({ method: 'POST', url: '/api/launch', headers: { host: '127.0.0.1:5577', 'content-type': 'application/json' }, ...over });
const h = (extra) => ({ host: '127.0.0.1:5577', 'content-type': 'application/json', ...extra });
const OPTS = { port: 5577, srpOrigin: 'https://srp.example' };

test('gateRequest: table', () => {
  const cases = [
    // description, request, expected status (0 = ok)
    ['own page, JSON POST', req({ headers: h({ origin: 'http://127.0.0.1:5577' }) }), 0],
    ['no Origin at all (curl, the guided notify)', req(), 0],
    ['localhost host with matching origin', req({ headers: h({ host: 'localhost:5577', origin: 'http://localhost:5577' }) }), 0],
    ['IPv6 loopback', req({ headers: h({ host: '[::1]:5577', origin: 'http://[::1]:5577' }) }), 0],
    ['GET static with own host', req({ method: 'GET', url: '/', headers: { host: '127.0.0.1:5577' } }), 0],
    ['GET SSE with own host', req({ method: 'GET', url: '/api/events', headers: { host: '127.0.0.1:5577' } }), 0],
    ['foreign Origin (CSRF)', req({ headers: h({ origin: 'https://evil.example' }) }), 403],
    ['Origin "null"', req({ headers: h({ origin: 'null' }) }), 403],
    ['DNS rebinding: foreign Host', req({ headers: h({ host: 'evil.example:5577' }) }), 403],
    ['wrong port in Host', req({ headers: h({ host: '127.0.0.1:5578' }) }), 403],
    ['missing Host', req({ headers: { 'content-type': 'application/json' } }), 403],
    ['text/plain POST to an API route (CORS-simple)', req({ headers: h({ 'content-type': 'text/plain' }) }), 415],
    ['no content type on an API POST', req({ headers: { host: '127.0.0.1:5577' } }), 415],
    ['JSON with a charset parameter', req({ headers: h({ 'content-type': 'application/json; charset=utf-8' }) }), 0],
    ['content type is case-insensitive', req({ headers: h({ 'content-type': 'Application/JSON' }) }), 0],
    ['SRP token POST from the SRP origin with text/plain', req({ url: '/api/srp/token', headers: h({ origin: 'https://srp.example', 'content-type': 'text/plain' }) }), 0],
    ['SRP token OPTIONS preflight from the SRP origin', req({ method: 'OPTIONS', url: '/api/srp/token', headers: { host: '127.0.0.1:5577', origin: 'https://srp.example' } }), 0],
    ['SRP token from any other origin', req({ url: '/api/srp/token', headers: h({ origin: 'https://evil.example', 'content-type': 'text/plain' }) }), 403],
    ['SRP token when no SRP origin is configured', req({ url: '/api/srp/token', headers: h({ origin: 'https://srp.example' }) }), 403],
  ];
  for (const [name, r, status] of cases) {
    const opts = name.includes('no SRP origin') ? { port: 5577, srpOrigin: null } : OPTS;
    const out = gateRequest(r, opts);
    if (status === 0) assert.equal(out.ok, true, `${name}: ${out.reason}`);
    else { assert.equal(out.ok, false, name); assert.equal(out.status, status, `${name}: ${out.reason}`); assert.ok(out.reason, name); }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/request-gate.test.mjs`
Expected: fails to import `./request-gate.mjs`.

- [ ] **Step 3: Implement the gate**

Create `lib/request-gate.mjs`:

```js
// The boundary in front of every route (spec §6). Pure: reads method, url
// and headers, touches nothing.
//
// Why each check exists — all three were verified against the running server
// on 2026-09-09:
//   Host    — with no check, a hostile domain resolving to 127.0.0.1 is
//             same-origin with forest in the browser (DNS rebinding) and can
//             READ the journal, diffs and the event stream.
//   Origin  — a browser sends it on every cross-site request; anything but
//             forest's own page is refused. Absent means a non-browser
//             client (curl, the guided-mode notify), admitted on Host alone.
//   Content — a cross-site fetch with a text/plain body is "CORS-simple" and
//             is sent with NO preflight; readBody parsed it as JSON anyway.
//             Requiring application/json on API POSTs closes that, because a
//             cross-site JSON POST is preflighted and nothing answers it.
// The one exception is /api/srp/token: the SRP bookmarklet posts text/plain
// on purpose and that route is guarded by its exact-origin rule instead.
export function gateRequest(req, { port, srpOrigin = null }) {
  const url = String(req.url || '').split('?')[0];
  const headers = req.headers || {};
  const host = String(headers.host || '').toLowerCase();
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!allowed.includes(host)) return { ok: false, status: 403, reason: `host ${host || '(none)'} is not forest` };
  const isSrpToken = url === '/api/srp/token';
  const origin = headers.origin;
  if (origin !== undefined) {
    if (isSrpToken) {
      if (!srpOrigin || origin !== srpOrigin) return { ok: false, status: 403, reason: `origin ${origin} is not the configured SRP origin` };
    } else if (origin !== `http://${host}`) {
      return { ok: false, status: 403, reason: `origin ${origin} is not forest` };
    }
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'POST' && url.startsWith('/api/') && !isSrpToken) {
    const ct = String(headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) return { ok: false, status: 415, reason: `content-type ${ct || '(none)'} is not application/json` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/request-gate.test.mjs`
Expected: pass.

- [ ] **Step 5: Wire it into `server.mjs`**

Add the imports:

```js
import { listPacks, autoSelections, packTargets } from './lib/packs.mjs';
import { gateRequest } from './lib/request-gate.mjs';
```

(replace the existing `import { listPacks } from './lib/packs.mjs';` line.)

Replace the start of the request handler:

```js
// One journal line per distinct (origin, host) that was refused, so an
// actual attempt is visible without a flood. Capped: an attacker must not be
// able to grow this without bound.
const refused = new Set();
const server = http.createServer(async (req, res) => {
  const gate = gateRequest(req, { port: config.port, srpOrigin: originOf(config.srpBaseUrl) });
  if (!gate.ok) {
    const key = `${req.headers.origin || '-'}|${req.headers.host || '-'}`;
    if (!refused.has(key) && refused.size < 100) {
      refused.add(key);
      journal.add({ cmd: `refused request from ${req.headers.origin || '(no origin)'} (host ${req.headers.host || '(none)'}): ${gate.reason}`, cwd: ROOT, mode: 'auto' });
    }
    res.writeHead(gate.status).end();
    return;
  }
  const url = req.url.split('?')[0];
```

Replace the comment above the `/api/srp/token` OPTIONS block (it no longer describes reality) with:

```js
  // Private Network Access preflight for the SRP bookmarklet's POST. The
  // request gate above has already required the configured SRP origin for
  // this path; these headers only let a legitimate SRP tab's fetch() succeed.
```

Replace the `/api/packs` line:

```js
  if (url === '/api/packs') {
    const repo = new URL(req.url, 'http://x').searchParams.get('repo');
    const packs = await listPacks(config.packsDir);
    return sendJson(res, { packs, auto: repo ? autoSelections(packs, repo) : [] });
  }
```

After the `pruneLandings` startup line, add the one-time targets check:

```js
// A catalog whose `targets` is not an array of strings is picker-only; say so
// once at startup rather than silently never auto-provisioning.
listPacks(config.packsDir).then((packs) => {
  for (const p of packs) {
    if (p.targets !== undefined && !Array.isArray(p.targets)) {
      journal.add({ cmd: `pack ${p.pack}: catalog "targets" is not an array — the pack will not auto-provision until it is`, cwd: ROOT, mode: 'auto' });
    } else if (Array.isArray(p.targets) && packTargets(p).length !== p.targets.length) {
      journal.add({ cmd: `pack ${p.pack}: some catalog "targets" entries are not non-empty strings and were ignored`, cwd: ROOT, mode: 'auto' });
    }
  }
}).catch(() => {});
```

- [ ] **Step 6: Verify against the running server**

`server.mjs` starts a listener on import, so it has no unit test; verify by hand:

```bash
forest restart
# a) the earlier finding, now closed: text/plain from a foreign origin
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5577/api/launch -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' --data '{}'
# expect 403
# b) JSON from the own page
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5577/api/launch -H 'Origin: http://127.0.0.1:5577' -H 'Content-Type: application/json' --data '{"agent":"nope"}'
# expect 400 (the route's own agent check — the gate let it through)
# c) rebinding
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5577/api/journal -H 'Host: evil.example:5577'
# expect 403
# d) the dashboard still loads and the packs route answers with auto
open http://127.0.0.1:5577
curl -s 'http://127.0.0.1:5577/api/packs?repo=web-test' | head -c 300
```

The journal panel shows one `refused request from https://evil.example …` line for (a) and one for (c).

- [ ] **Step 7: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 11: Picker pre-ticks the automatic selection; the Tickets modal sends selections only when saved

**Files:**
- Modify: `public/app.js` (`renderPack` ~line 795, `openPicker` ~line 838)
- Modify: `public/style.css` (after `.pk-count`, line 385)
- Modify: `public/tickets.js` (`renderSkills` ~line 441, `startTerminal` ~line 526, `startCursor` ~line 549, `resolveBlock`'s force retry ~line 647)

There is no browser test harness in this repo; verification is manual in Step 4.

- [ ] **Step 1: `renderPack` takes an `auto` flag and shows a tag**

```js
function renderPack(p, picked, auto = false) {
  …
  const tag = auto ? '<span class="pk-auto" title="Pre-ticked: this pack targets this repo (catalog targets)">auto</span>' : '';
  const head = `<div class="pk-pack-h"><label class="pk-all-row"><input type="checkbox" class="pk-all" /> Select all ${esc(p.pack)}</label>${tag}</div>`;
  return `<div class="pk-pack">${head}${sections}${kitSection}${hooksSection}</div>`;
}
```

In `public/style.css`, after the `.pk-count` rule:

```css
.pk-auto { margin-left: 8px; padding: 1px 6px; border-radius: 4px; font-size: 11px; color: var(--muted); border: 1px solid var(--muted); vertical-align: middle; }
```

- [ ] **Step 2: `openPicker` pre-ticks from `/api/packs?repo=` when nothing is saved**

```js
async function openPicker(path) {
  const w = findWorktree(path);
  if (!w) return;
  pickerPath = path;
  $('#pk-sub').textContent = `${w.repo} · ${w.branch || '(detached)'}`;
  // A saved selection is the override and wins. Otherwise the server's
  // automatic selection for this repo is what a launch would install, so it
  // is what the boxes show — the picker never re-implements the targeting
  // rule (the server owns it; see autoSelections in lib/packs.mjs).
  let sel = loadSel(path);
  const autoPacks = new Set();
  if (!Object.keys(sel).length) {
    const j = await fetch(`/api/packs?repo=${encodeURIComponent(w.repo)}`).then((r) => r.json()).catch(() => ({ auto: [] }));
    sel = {};
    for (const a of (j.auto || [])) { sel[a.pack] = { skills: a.skills, kits: a.kits, hooks: a.hooks }; autoPacks.add(a.pack); }
  }
  if (pickerPath !== path) return; // the picker moved on while the fetch was in flight
  $('#pk-body').innerHTML = state.packs.length
    ? state.packs.map((p) => renderPack(p, sel[p.pack] || {}, autoPacks.has(p.pack))).join('')
    : `<p class="pk-empty">No skill packs found in <code>packs/</code>. The session will start with no extra skills.</p>`;
  $('#picker').classList.remove('hidden');
  syncMasters();
  setPickerAgent(loadAgent(localStorage, path), { persist: false });
}
```

Every caller of `openPicker` keeps working unchanged (it was synchronous; nothing awaited it).

- [ ] **Step 3: The Tickets modal omits `selections` when nothing is saved**

In `public/tickets.js`, add one helper next to `savedSelections`:

```js
// The body fields for a launch: `selections` only when this checkout has a
// saved picker selection (the override). Omitting the key lets the server
// apply the catalog's automatic selection — the whole pack for a targeted
// repo — which makes mergeRequiredSkills' two-skill floor moot there.
function selectionFields(primaryPath) {
  const saved = savedSelections(primaryPath);
  return saved.length ? { selections: mergeRequiredSkills(saved, D.state.packs).selections } : {};
}
```

`startTerminal`:
```js
  const r = await D.api('/api/launch', { path: target.primaryPath, ...selectionFields(target.primaryPath), prompt, mode: D.state.mode, agent });
```

`startCursor`:
```js
  const r = await D.api('/api/tickets/worktrees', { repoPath: target.repoPath, tickets, ...selectionFields(target.primaryPath), boxes, prompt });
```

The orphaned-units force retry (currently `await forceLaunch(mergeRequiredSkills(savedSelections(target.primaryPath), D.state.packs).selections, prompt);`) becomes `await forceLaunch(selectionFields(target.primaryPath).selections, prompt);`, and `forceLaunch` spreads it: replace `selections,` in its body with `...(selections ? { selections } : {}),`.

`renderSkills`: when `savedSelections(target.primaryPath)` is empty, set the footer to `skills: automatic (pack targets)` and no warning class:

```js
  if (target && !savedSelections(target.primaryPath).length) {
    el.textContent = 'skills: automatic (pack targets)';
    el.classList.remove('tk-warn');
    return;
  }
```

placed at the top of `renderSkills` before `merge` is computed.

- [ ] **Step 4: Verify in the browser**

```bash
forest restart && open http://127.0.0.1:5577
```

1. Open the picker on a `web-test` worktree that has never been through it (clear `localStorage` key `forest-skills:<path>` in devtools if needed). Every Hektor group is pre-ticked, the pack header shows the `auto` tag, the count line reads `N selected` with N equal to the catalog's skill count plus kits plus one gate row.
2. Open it on a `forest` worktree: nothing pre-ticked, no tag.
3. Untick one skill on the web-test worktree and Start: the next open shows that override, without the tag.
4. Tickets modal on web-test with no saved selection: the footer reads `skills: automatic (pack targets)`; the network tab shows the launch body without a `selections` key.

- [ ] **Step 5: Run the full suite; leave the diff in the working tree**

Run: `npm test` (the `public/*.test.mjs` files run too). Do not commit.

---

### Task 12: README in Turkish, with the team install, auto-provisioning and trust sections

**Files:**
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Write the README**

Replace the whole of `README.md` with:

````markdown
# Forest 🌲

Tüm depolarınızdaki git worktree'lerini takip eden ve bir dalda Claude ya da
Cursor başlatan, bağımlılığı olmayan yerel bir web paneli. Yalnızca Node gerekir
(sadece yerleşik modüller, `npm install` yok). Sunucu `127.0.0.1` adresine
bağlanır.

## Çalıştırma

    forest            # sunucuyu (kapalıysa) başlatır ve paneli açar

    forest up         # sunucuyu başlatır; tarayıcı açmaz
    forest down       # sunucuyu durdurur
    forest status     # çalışıyor/durdu bilgisini pid ve port ile verir
    forest restart    # durdurup yeniden başlatır

`forest status`, sunucu çalışıyorsa 0, çalışmıyorsa 1 ile çıkar; böylece
zincirlenebilir: `forest status && open http://127.0.0.1:5577`.

Forest sunucusunu, yapılandırılmış porttaki dinleyiciye bakıp sürecin gerçekten
`node server.mjs` olduğunu doğrulayarak bulur. Portta başka bir şey oturuyorsa
`forest down` bunu bildirir ve öldürmeyi reddeder.

Ya da doğrudan:

    node server.mjs

Sonra http://127.0.0.1:5577 adresini açın.

## Ekip için kurulum

Forest beceri paketini kendi içinde taşır (`packs/`), bu yüzden tek bir klon her
şeyi getirir.

Gereksinimler: Node 20 veya üstü, git, `jq` (paket kurucusu kullanır), macOS
(başlatma için).

1. Depoyu klonlayın: `git clone <url> ~/code/forest`.
2. `forest` komutunu PATH'e alın: `ln -s "$PWD/bin/forest" ~/.local/bin/forest`.
3. `cp config.example.json config.json`; `roots`, `jiraBaseUrl`,
   `jiraProjectKey` ve `jiraToken` değerlerini girin.
4. `forest`.

`web-test` ve `test-data-client` worktree'leri oluşturulurken otomatik
hazırlanır ve her başlatmada yeniden denetlenir. Paketi güncellemek için
forest'ta `git pull` yeterlidir; her worktree bir sonraki başlatmada yenilenir.

## Otomatik hazırlama

Her paketin `catalog.json` dosyasındaki `targets` listesi, paketin hangi depolar
için olduğunu söyler (forest'ın listelediği depo adı; `*` hepsi demektir).
Hedeflenen bir deponun worktree'si oluşturulduğunda ve her başlatmada forest
paketin tamamını iki eksene yazar: `.claude/` (beceriler, kitler, kapılar) ve
`.cursor/` (paketin kendi `install.sh` betiği ile). Paket değişmediyse (git
ağaç özeti aynıysa) iş atlanır. Yerel olarak düzenlenmiş bir hazırlanmış dosya
yenilemede üzerine yazılır ve günlükte adıyla listelenir.

Guided kipte worktree oluşturma komutu, git bittiğinde forest'a haber veren bir
`curl` çağrısıyla biter; hazırlama ancak checkout tamamlandığında başlar.

Başlatma seçici (picker) açıldığında otomatik seçim işaretli gelir; işareti
kaldırmak seçimi bu worktree için geçersiz kılar. `config.json` içinde
`"autoProvision": false` otomatik hazırlamayı kapatır; seçici çalışmaya devam
eder.

Claude tarafı bugün yalnızca becerileri alır: paketin kapıları Cursor biçiminde
yanıt verir. Kapıların Claude sürümü pakette ayrı bir iş olarak planlandı.

Bilinen yan etki: paket kurucusu, hedef deponun izlenen `.gitignore` dosyasına
çalışma durumu için bir blok ekler (yoksa). `web-test` bu bloğu zaten taşır;
başka bir hedef depoda ilk başlatma bu dosyayı bir kez değiştirir.

## Güven

Paketin kurucusu, kapı betikleri ve kit kurucusu, her ekip üyesinin makinesinde
bir sonraki başlatmada çalışır. `packs/` dizinini `CODEOWNERS` ile koruyun ve
inceleme zorunlu tutun. Forest paketi yalnızca kendi klonundan okur; hiçbir
zaman indirmez.

Sunucu yalnızca `127.0.0.1` üzerinde dinler ve her isteğin `Host` ve `Origin`
başlıklarını denetler; `/api/*` POST istekleri `application/json` içerik türü
ister. Reddedilen istekler günlükte bir kez görünür.

## Başka bir makinede kullanım

Forest'ta sabit yol yoktur; istediğiniz yere klonlayıp kodunuza yöneltin.

1. Depoyu klonlayın, ör. `git clone <url> ~/code/forest`.
2. Forest'a depolarınızın yerini söyleyin (birini seçin):
   - **Kural (sıfır yapılandırma):** Forest `<root>/APPS/forest` altındaysa
     deste kökü otomatik olarak `<root>` olur.
   - **`config.json`:** `cp config.example.json config.json` ve `roots`
     değerini girin.
   - **Ortam değişkenleri:** `FOREST_ROOTS=/path/a,/path/b FOREST_PORT=5577 node server.mjs`.
3. (İsteğe bağlı) `bin/forest` betiğini `PATH`'e alın:
   `ln -s "$PWD/bin/forest" ~/.local/bin/forest` — kendi konumunu çözer, her
   yerden çalışır.

> Şimdilik yalnızca macOS: Claude/Cursor başlatma ve "guided" terminal
> eylemleri `open`/AppleScript kullanır. Panelin kendisi platformdan
> bağımsızdır.

## Duruş

Forest bir cam kokpittir, otopilot değil. Görünürlük tamamen arayüzde;
değişiklikler önce terminalde. Başlıktaki **Guided ⟷ Auto** anahtarı bir eylemin
terminalinizde mi (akıcılığınızı korursunuz) yoksa arka planda mı (günlüğe
yazılır) çalışacağına karar verir. İki kip de yıkıcı eylemleri onaylatır ve bir
deponun birincil worktree'sine asla dokunmaz.

## Worktree açıklamaları

Her worktree'nin çekmecesinde bir açıklama vardır. Başlangıçta dalın biletinden
oluşur: iş başlığı, ardından tarama bağlantısı; düz metin olarak okunur ve bilet
URL'si tıklanabilir. **Edit** bunu istediğinizi yazabileceğiniz bir kutuya
çevirir; düğme **Save** olur, geri çıkmak için **Cancel**, bilet metnine dönmek
için **Reset to auto** vardır. `Description` başlığı bölümü katlar ve tercih
hatırlanır.

Geçersiz kılmalar dal başına `<repo>/.forest/descriptions.json` içinde saklanır;
worktree silinip yeniden oluşturulsa da kalır.

Destedeki dal adları bilerek bağlantı değildir: satıra tıklamak çekmeceyi açar,
bilet bağlantısı açıklamadadır.

Başlıkları okumak `jiraBaseUrl` ve `jiraToken` ister (aşağıda). Bunlar olmadan
açıklama yalnızca bağlantıya düşer; geri kalan her şey çalışır.

## Yapılandırma

`config.json` (gitignore'da, makineye özel) yerleşik varsayılanları geçersiz
kılar; her anahtarın `FOREST_*` ortam değişkeni karşılığı da vardır. Başlamak
için `config.example.json` dosyasını `config.json` olarak kopyalayın.

| Anahtar | Ortam | Varsayılan | Anlamı |
|-----|-----|---------|---------|
| `roots` | `FOREST_ROOTS` | `<install>/../..` | git depoları için taranan dizinler |
| `containers` | `FOREST_CONTAINERS` | `["APPS"]` | çocukları tek tek listelenen git olmayan klasörler |
| `packsDir` | `FOREST_PACKS_DIR` | `<forest>/packs` | beceri paketlerinin okunduğu dizin |
| `autoProvision` | — | `true` | hedeflenen depoların worktree'lerini otomatik hazırla |
| `port` | `FOREST_PORT` | `5577` | sunucu portu |
| `jiraBaseUrl` | `FOREST_JIRA_URL` | `""` | dal biletlerini Jira'ya bağlar |
| `jiraProjectKey` | `FOREST_JIRA_PROJECT_KEY` | `""` | dalın biletini yeniden anahtarlar (`WEBT-1` → `SHBDN-1`); boş = dalın kendi anahtarı |
| `jiraToken` | `FOREST_JIRA_TOKEN` | `""` | iş başlıklarını okumak için PAT; tarayıcıya asla gönderilmez |
| `jiraEmail` | `FOREST_JIRA_EMAIL` | `""` | yalnızca Jira Cloud için; Basic `email:token` ister |
| `staleDays` | — | `14` | bir worktree'nin bayat sayılacağı yaş |
| `defaultMode` | — | `guided` | `guided` ya da `auto` |
| `terminalApp` / `openEditorCmd` / `setupScript` | — | macOS varsayılanları | başlatma yardımcıları |

## Test

    npm test    # lib/*.test.mjs üzerinde node --test
````

- [ ] **Step 2: Check the identifiers survived verbatim**

Run:
```bash
grep -c 'FOREST_' README.md          # expect 10 (8 table rows, the env-var example line, the `FOREST_*` sentence)
grep -n 'SKLS' README.md             # expect nothing
grep -n 'autoProvision\|packsDir' README.md | wc -l   # expect 3
```

- [ ] **Step 3: Run the full suite; leave the diff in the working tree**

Run: `npm test`. Do not commit.

---

### Task 13: Manual verification pass (requires Task 0)

**Files:** none. Record each outcome in the journal panel or as a note for the user.

- [ ] **Step 1: Restart and confirm the pack is seen**

```bash
forest restart
curl -s 'http://127.0.0.1:5577/api/packs?repo=web-test' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.packs.map(p=>p.pack), j.auto.map(a=>[a.pack,a.skills.length,a.kits.length,a.hooks]))})'
```
Expected: `[ 'hektor' ]` and `[ [ 'hektor', <catalog skill count>, 1, true ] ]`.

- [ ] **Step 2: Create a web-test worktree in auto mode from the dashboard**

Header toggle on Auto, create branch `tech/WEBT-forest-verify` on `web-test`. Then:

```bash
WT=~/.forest/wt/web-test/tech-WEBT-forest-verify
ls $WT/.claude/skills | wc -l         # equals the catalog skill count that the pack actually ships
ls $WT/.cursor/skills | wc -l         # same order of magnitude; the pack's own installer wrote it
jq '.hooks | map(length) | add' $WT/.cursor/hooks.json     # 18
jq '{auto, fingerprints, cursor}' $WT/.claude/.forest-provision.json
git -C $WT status --short              # nothing under .claude/ or .cursor/ (git-excluded)
```

The journal shows `provision (create): … → .claude/; .cursor/ wired`.

- [ ] **Step 3: Create one in guided mode**

Toggle Guided, create `tech/WEBT-forest-verify-2`. The Terminal window shows the git line ending in `&& curl … /api/worktree/provision`, and after it finishes the journal shows `provision (provision): …`. Same checks as Step 2 on that path.

- [ ] **Step 4: Launch both agents; confirm the skip**

Launch Claude on the first worktree from the picker (pre-ticked). The journal shows no `provision (launch)` line (skipped as unchanged) and the session opens. Quit it, launch Cursor CLI: same. Then edit one provisioned file:

```bash
echo '# local edit' >> $WT/.claude/skills/hektor-verify/SKILL.md
```

Launch again: still skipped (the pack did not change; local edits are not detected by the fingerprint, by design). Now change the pack: edit `packs/hektor/skills/hektor-verify/SKILL.md` in forest and commit it (user), then launch: the journal shows `refresh: overwrote 1 provisioned file(s): .claude/skills/hektor-verify/SKILL.md` and `provision (launch): …`.

- [ ] **Step 5: The gate, from a browser**

In any other site's devtools console:
```js
fetch('http://127.0.0.1:5577/api/task', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ path: '/tmp', prompt: 'hi' }) })
```
No Terminal opens, no headless session starts, and the journal shows one `refused request from <that origin> …: content-type text/plain…` line.

- [ ] **Step 6: Tickets modal**

Open the Tickets modal on web-test with no saved picker selection, pick one ticket, target Cursor. The worktree it creates has both axes and `"auto": true` in its record.

- [ ] **Step 7: Clean up**

Remove the two verification worktrees from the dashboard (Guided or Auto, both confirm), then delete their branches by hand:

```bash
git -C /Users/egecan.sen/sahibinden/repo/web-test branch -D tech/WEBT-forest-verify tech/WEBT-forest-verify-2
```

- [ ] **Step 8: Hand back**

Report to the user: every task's `npm test` result, the manual checks above with what was observed, and the three things left for them: commit, push, add the `CODEOWNERS` line `packs/ @<team-handle>` under `.github/`, and update the memory note that still names `SKLS/hektor` as the kit source of truth.
