# Kit Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a forest session see exactly the kits it was launched with — worktrees move out of the repo tree, kits carry their own hooks, and every registered hook is verified to resolve to a real file.

**Architecture:** Four independent pieces. `config.worktreeRoot` becomes the single source of worktree paths, so new worktrees live at `~/.forest/wt/<repo>/<branch>` and inherit no ancestor `.claude/settings.json`. `lib/packs.mjs` gains a hash-aware copy (no silent clobbering) and provisions a kit by convention (`hooks/`, `schemas/`, `skills/`, `settings.hooks.json`), recording what it did in `.claude/.forest-provision.json`. A new `lib/session-scope.mjs` reproduces Claude Code's settings merge and reports which hook commands resolve to existing files. The UI consumes that resolver in three places: a pre-launch preview, a post-provision warning, and a per-worktree gate badge with a repair action.

**Tech Stack:** Node 20+ ESM (`.mjs`), `node:test` + `node:assert/strict`, zero runtime dependencies, vanilla JS frontend (no framework, no build step).

## Global Constraints

- **No new dependencies.** The repo has none; use `node:` builtins only.
- **Test command:** `node --test` from the repo root (`package.json` → `"test": "node --test"`). Every task ends with the full suite green, not just the new file.
- **Style:** ESM, 2-space indent, single quotes, semicolons, `const` arrow helpers for one-liners — match the surrounding file.
- **No personal paths in source.** `lib/config.test.mjs:26` asserts `lib/config.mjs` contains neither `/Users/` nor `sahibinden`. Use `os.homedir()`.
- **Spec:** `docs/superpowers/specs/2026-07-29-kit-isolation-design.md` — the source of truth for behaviour decisions.
- **Backwards compatibility is required.** Worktrees created before this change stay listed and functional; nothing is auto-migrated.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/config.mjs` (modify) | Adds `worktreeRoot` default + `worktreePathFor()`. The only place a worktree path is composed. |
| `lib/actions.mjs` (modify) | Uses `worktreePathFor` at creation; returns session scope from `/api/launch`; adds `/api/worktree/scope` and `/api/worktree/repair`. |
| `lib/packs.mjs` (modify) | Hash-aware `copyTree`, `readKitManifest`, `provisionKit`, provision record read/write. |
| `lib/session-scope.mjs` (create) | Pure resolver: which hooks a session will load, and which of them are missing from disk. |
| `lib/discover.mjs` (modify) | Attaches `scope: { active, missing }` to each worktree record. |
| `lib/finish-fixtures.mjs` (modify) | `makeRepoWithWorktree({ root })` so tests can build out-of-tree worktrees. |
| `public/app.js`, `public/index.html`, `public/style.css` (modify) | Gate badge, launch warning, picker scope preview, repair button. |
| `lib/config.test.mjs` (modify) | Covers `worktreeRoot` + `worktreePathFor`. |
| `lib/actions.test.mjs` (create) | Guards that the `.forest/wt` literal is gone. |
| `lib/packs.test.mjs` (create) | Covers `copyTree`, kit conventions, provision record. |
| `lib/session-scope.test.mjs` (create) | Covers ancestor walk, expansion, classification, dedupe. |
| `lib/finish.test.mjs` (modify) | Regression: finish works on an out-of-tree worktree. |

---

### Task 1: `worktreeRoot` config key and path helper

**Files:**
- Modify: `lib/config.mjs:1-25`
- Test: `lib/config.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULTS.worktreeRoot: string` (absolute, defaults to `<home>/.forest/wt`, overridable with `FOREST_WORKTREE_ROOT` or `config.json`) and
  `worktreePathFor({ worktreeRoot: string, repoPath: string, branchSlug: string }) → string`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/config.test.mjs` (and add `worktreePathFor` to the existing import on line 6):

```js
test('DEFAULTS.worktreeRoot is absolute and ends in .forest/wt', () => {
  assert.ok(DEFAULTS.worktreeRoot.startsWith('/'));
  assert.ok(DEFAULTS.worktreeRoot.endsWith(join('.forest', 'wt')));
});

test('mergeConfig overrides worktreeRoot', () => {
  const c = mergeConfig({ worktreeRoot: '/tmp/wt' });
  assert.equal(c.worktreeRoot, '/tmp/wt');
});

test('worktreePathFor nests the repo name under the root', () => {
  const p = worktreePathFor({ worktreeRoot: '/wt', repoPath: '/a/b/web-test', branchSlug: 'tech-WEBT-1' });
  assert.equal(p, '/wt/web-test/tech-WEBT-1');
});

test('worktreePathFor never returns a path inside the repo', () => {
  const repoPath = '/a/b/web-test';
  const p = worktreePathFor({ worktreeRoot: '/wt', repoPath, branchSlug: 's' });
  assert.ok(!p.startsWith(repoPath));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/config.test.mjs`
Expected: FAIL — `worktreePathFor is not a function` and `DEFAULTS.worktreeRoot` undefined.

- [ ] **Step 3: Implement in `lib/config.mjs`**

Extend the imports on lines 1-3 and add the key plus the helper:

```js
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
```

Inside `DEFAULTS`, after `packsDir`:

```js
  // Worktrees live OUTSIDE every repo tree: a session started inside a repo
  // inherits that repo's .claude/settings.json (Claude Code merges ancestor
  // settings) while $CLAUDE_PROJECT_DIR points at the worktree, so every hook
  // script that was not provisioned there fails with exit 127.
  worktreeRoot: process.env.FOREST_WORKTREE_ROOT || join(homedir(), '.forest', 'wt'),
```

At the end of the file:

```js
// Absolute path for a repo's worktree: <worktreeRoot>/<repo dir name>/<branch slug>.
export function worktreePathFor({ worktreeRoot, repoPath, branchSlug }) {
  return join(worktreeRoot, basename(repoPath), branchSlug);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/config.test.mjs`
Expected: PASS, including the pre-existing "bakes in no personal path" test (`homedir()` keeps the source clean).

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs lib/config.test.mjs
git commit -m "feat(config): worktreeRoot + worktreePathFor — worktrees outside the repo tree"
```

---

### Task 2: Create worktrees under the new root

**Files:**
- Modify: `lib/actions.mjs:1-3` (imports), `lib/actions.mjs:38-44` (`/api/worktree/create`)
- Test: `lib/actions.test.mjs` (create)

**Interfaces:**
- Consumes: `worktreePathFor` from Task 1.
- Produces: worktree creation at `<config.worktreeRoot>/<repo>/<slug(branch)>`; no behaviour change to the `/api/worktree/create` request or response shape.

- [ ] **Step 1: Write the failing test**

Create `lib/actions.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('worktree creation composes its path via worktreePathFor', async () => {
  const src = await readFile(new URL('./actions.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('worktreePathFor'), 'actions.mjs must use the shared path helper');
  assert.ok(!src.includes('.forest/wt'), 'the .forest/wt literal must live only in config.mjs');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/actions.test.mjs`
Expected: FAIL — "actions.mjs must use the shared path helper".

- [ ] **Step 3: Implement in `lib/actions.mjs`**

Change the imports on lines 1-3 to:

```js
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
```

Add to the import block (after line 9):

```js
import { worktreePathFor } from './config.mjs';
```

Replace the body of the `/api/worktree/create` branch (currently line 40's `const wtPath = ...`):

```js
        const wtPath = worktreePathFor({
          worktreeRoot: ctx.config.worktreeRoot,
          repoPath,
          branchSlug: slug(branch),
        });
        await mkdir(dirname(wtPath), { recursive: true });
```

`git worktree add` creates the leaf directory itself; the `mkdir` guarantees the `<root>/<repo>` parent exists on a machine that has never made a worktree before.

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS — `lib/actions.test.mjs` green and nothing else regressed.

- [ ] **Step 5: Commit**

```bash
git add lib/actions.mjs lib/actions.test.mjs
git commit -m "feat(worktree): create under configured worktreeRoot"
```

---

### Task 3: Prove finish works on an out-of-tree worktree

**Files:**
- Modify: `lib/finish-fixtures.mjs:18-29`
- Test: `lib/finish.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `makeRepoWithWorktree({ branch?: string, root?: string }) → { repo, wt, branch }` — `root` defaults to `<repo>/.forest/wt`, preserving every existing caller.

- [ ] **Step 1: Write the failing test**

Append to `lib/finish.test.mjs` (the file already imports `mkdtemp`, `tmpdir`, `join`, `rm`, `executeFinish`, `makeRepoWithWorktree`, `commitFile`, `git`; add any that are missing):

```js
test('executeFinish: worktree living outside the repo tree lands and is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forest-wtroot-'));
  const { repo, wt, branch } = await makeRepoWithWorktree({ branch: 'tech/OUT-1', root });
  try {
    assert.ok(!wt.startsWith(repo), 'fixture must place the worktree outside the repo');
    await commitFile(wt, 'out.txt', 'work\n', 'feat');
    const r = await executeFinish({ repoPath: repo, path: wt });
    assert.equal(r.targetBranch, branch);
    assert.equal(r.landed, true);
    assert.equal(r.removed, true);
    assert.equal((await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim(), branch);
    assert.equal((await git(repo, 'worktree', 'list', '--porcelain')).includes(wt), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/finish.test.mjs`
Expected: FAIL — the fixture ignores `root`, so `wt.startsWith(repo)` is true.

- [ ] **Step 3: Implement in `lib/finish-fixtures.mjs`**

Add `mkdir` to the `node:fs/promises` import on line 4, then replace lines 18-29:

```js
// Fixture: a primary repo with one commit on master and a worktree holding
// <branch>. `root` defaults to the legacy in-repo location; pass an out-of-tree
// root to exercise the isolated layout. Caller must rm() both.
export async function makeRepoWithWorktree({ branch = 'tech/WEBT-1', root } = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'forest-finish-'));
  await git(repo, 'init', '-b', 'master');
  await git(repo, 'config', 'user.email', 't@t');
  await git(repo, 'config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const wtRoot = root || join(repo, '.forest', 'wt');
  await mkdir(wtRoot, { recursive: true });
  const wt = join(wtRoot, slug(branch));
  await git(repo, 'worktree', 'add', '-b', branch, wt, 'HEAD');
  return { repo, wt, branch };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS — the new test plus every existing `finish`/`landed` test, which still get the in-repo default.

- [ ] **Step 5: Commit**

```bash
git add lib/finish-fixtures.mjs lib/finish.test.mjs
git commit -m "test(finish): cover landing a worktree that lives outside the repo"
```

---

### Task 4: Hash-aware copy — no silent clobbering

**Files:**
- Modify: `lib/packs.mjs:1-2` (imports), add `copyTree` after `mergeHooks`
- Test: `lib/packs.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `copyTree(src, dest, { owner?: string, conflicts?: Array, written?: Map }) → Promise<{ copied: number }>`.
  `conflicts` entries are `{ path: string, incoming: string, existing: string }` where `path` is the destination path and the two ids name the kits (or `'preexisting'`). A missing `src` is a no-op, matching today's "missing source — skip" behaviour.

- [ ] **Step 1: Write the failing tests**

Create `lib/packs.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTree } from './packs.mjs';

const tmp = (p) => mkdtemp(join(tmpdir(), p));

test('copyTree copies new files and preserves the executable bit', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await mkdir(join(src, 'lib'), { recursive: true });
  await writeFile(join(src, 'gate.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(src, 'gate.sh'), 0o755);
  await writeFile(join(src, 'lib', 'audit.sh'), 'audit\n');
  const conflicts = [];
  const r = await copyTree(src, dst, { owner: 'kit-a', conflicts });
  assert.equal(r.copied, 2);
  assert.equal(await readFile(join(dst, 'lib', 'audit.sh'), 'utf8'), 'audit\n');
  assert.equal((await stat(join(dst, 'gate.sh'))).mode & 0o111, 0o111);
  assert.deepEqual(conflicts, []);
});

test('copyTree skips byte-identical files without reporting a conflict', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await writeFile(join(src, 'audit.sh'), 'same\n');
  await writeFile(join(dst, 'audit.sh'), 'same\n');
  const conflicts = [];
  const r = await copyTree(src, dst, { owner: 'kit-b', conflicts });
  assert.equal(r.copied, 0);
  assert.deepEqual(conflicts, []);
});

test('copyTree refuses to overwrite differing content and names both owners', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await writeFile(join(src, 'audit.sh'), 'v2\n');
  await writeFile(join(dst, 'audit.sh'), 'v1\n');
  const conflicts = [];
  const written = new Map([[join(dst, 'audit.sh'), 'kit-a']]);
  await copyTree(src, dst, { owner: 'kit-b', conflicts, written });
  assert.equal(await readFile(join(dst, 'audit.sh'), 'utf8'), 'v1\n', 'destination must survive');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].incoming, 'kit-b');
  assert.equal(conflicts[0].existing, 'kit-a');
});

test('copyTree reports a pre-existing file it did not write', async () => {
  const src = await tmp('forest-src-'), dst = await tmp('forest-dst-');
  await writeFile(join(src, 'a.sh'), 'new\n');
  await writeFile(join(dst, 'a.sh'), 'old\n');
  const conflicts = [];
  await copyTree(src, dst, { owner: 'kit-a', conflicts });
  assert.equal(conflicts[0].existing, 'preexisting');
});

test('copyTree treats a missing source as a no-op', async () => {
  const dst = await tmp('forest-dst-');
  const conflicts = [];
  const r = await copyTree('/no/such/source', dst, { owner: 'kit-a', conflicts });
  assert.equal(r.copied, 0);
  assert.deepEqual(conflicts, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/packs.test.mjs`
Expected: FAIL — `copyTree is not exported`.

- [ ] **Step 3: Implement in `lib/packs.mjs`**

Replace the imports on lines 1-3 with:

```js
import { readdir, readFile, writeFile, mkdir, cp, copyFile, chmod, stat, appendFile } from 'node:fs/promises';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
```

Add after `mergeHooks` (line 64):

```js
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Copy a tree without ever clobbering differing content: identical files are
// skipped, a destination that differs is left alone and reported. `written`
// maps destination path → owner id so a conflict can name both sides when both
// writes happen inside one provision run.
export async function copyTree(src, dest, { owner = 'unknown', conflicts = [], written = new Map() } = {}) {
  let entries;
  try { entries = await readdir(src, { withFileTypes: true }); } catch { return { copied: 0 }; }
  await mkdir(dest, { recursive: true });
  let copied = 0;
  for (const e of entries) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isDirectory()) {
      copied += (await copyTree(from, to, { owner, conflicts, written })).copied;
      continue;
    }
    if (!e.isFile()) continue;
    const incoming = await readFile(from);
    let existing = null;
    try { existing = await readFile(to); } catch { /* absent — free to write */ }
    if (existing && sha(existing) !== sha(incoming)) {
      conflicts.push({ path: to, incoming: owner, existing: written.get(to) || 'preexisting' });
      continue;
    }
    if (!existing) {
      await copyFile(from, to);
      await chmod(to, (await stat(from)).mode & 0o777);   // hooks must stay executable
      copied += 1;
    }
    written.set(to, owner);
  }
  return { copied };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/packs.mjs lib/packs.test.mjs
git commit -m "feat(packs): hash-aware copyTree — report conflicts instead of clobbering"
```

---

### Task 5: Kit conventions and optional `kit.json`

**Files:**
- Modify: `lib/packs.mjs` (add `readKitManifest` + `provisionKit`, rewire `provisionPack:68-96`)
- Test: `lib/packs.test.mjs`

**Interfaces:**
- Consumes: `copyTree` (Task 4), the file-private `mergeHooks`.
- Produces:
  - `readKitManifest(kitDir) → Promise<{ id, label, description, hooksDir, schemasDir, settingsFile, skillsDir }>` — conventions when `kit.json` is absent or unreadable.
  - `provisionKit({ kitDir, kitId, worktreePath, conflicts, written }) → Promise<{ id: string, skills: string[] }>`.
  - `provisionPack(...)` return grows `conflicts: Array` and `kitSkills: string[]`; existing fields keep their meaning.

- [ ] **Step 1: Write the failing tests**

Append to `lib/packs.test.mjs` (extend the import to `{ copyTree, readKitManifest, provisionKit }`):

```js
test('readKitManifest falls back to conventions when kit.json is absent', async () => {
  const kit = await tmp('forest-kit-');
  const m = await readKitManifest(kit);
  assert.equal(m.hooksDir, 'hooks');
  assert.equal(m.schemasDir, 'schemas');
  assert.equal(m.skillsDir, 'skills');
  assert.equal(m.settingsFile, 'settings.hooks.json');
});

test('readKitManifest lets kit.json override the hooks directory', async () => {
  const kit = await tmp('forest-kit-');
  await writeFile(join(kit, 'kit.json'), JSON.stringify({
    id: 'flaky', label: 'Flaky', hooks: { dir: 'adapters/claude', settings: 'gates.json' },
  }));
  const m = await readKitManifest(kit);
  assert.equal(m.id, 'flaky');
  assert.equal(m.hooksDir, 'adapters/claude');
  assert.equal(m.settingsFile, 'gates.json');
  assert.equal(m.schemasDir, 'schemas');   // untouched keys keep the convention
});

test('provisionKit installs hooks, skills and the settings fragment', async () => {
  const kit = await tmp('forest-kit-'), wt = await tmp('forest-wt-');
  await mkdir(join(kit, 'hooks'), { recursive: true });
  await writeFile(join(kit, 'hooks', 'gate.sh'), '#!/bin/sh\n');
  await chmod(join(kit, 'hooks', 'gate.sh'), 0o755);
  await mkdir(join(kit, 'skills', 'my-skill'), { recursive: true });
  await writeFile(join(kit, 'skills', 'my-skill', 'SKILL.md'), '# skill\n');
  await writeFile(join(kit, 'settings.hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"' }] }] },
  }));

  const conflicts = [];
  const r = await provisionKit({ kitDir: kit, kitId: 'my-kit', worktreePath: wt, conflicts, written: new Map() });

  assert.deepEqual(r.skills, ['my-skill']);
  assert.equal((await stat(join(wt, '.claude', 'hooks', 'gate.sh'))).mode & 0o111, 0o111);
  assert.equal(await readFile(join(wt, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'utf8'), '# skill\n');
  assert.ok(await readFile(join(wt, '.claude', 'kits', 'my-kit', 'settings.hooks.json'), 'utf8'));
  const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh"');
  assert.deepEqual(conflicts, []);
});

test('provisionKit is idempotent — a second run adds no duplicate registration', async () => {
  const kit = await tmp('forest-kit-'), wt = await tmp('forest-wt-');
  await writeFile(join(kit, 'settings.hooks.json'), JSON.stringify({
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x.sh' }] }] },
  }));
  const args = { kitDir: kit, kitId: 'k', worktreePath: wt, conflicts: [], written: new Map() };
  await provisionKit(args);
  await provisionKit({ ...args, written: new Map() });
  const settings = JSON.parse(await readFile(join(wt, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings.hooks.Stop[0].hooks.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/packs.test.mjs`
Expected: FAIL — `readKitManifest is not exported`.

- [ ] **Step 3: Implement in `lib/packs.mjs`**

Add after `copyTree`:

```js
const KIT_DEFAULTS = { hooks: 'hooks', schemas: 'schemas', skills: 'skills', settings: 'settings.hooks.json' };

// A kit describes itself by convention; kit.json only carries display metadata
// or an override for a kit that deviates from the layout.
export async function readKitManifest(kitDir) {
  let m = {};
  try { m = JSON.parse(await readFile(join(kitDir, 'kit.json'), 'utf8')); } catch { /* conventions only */ }
  const h = m.hooks || {};
  return {
    id: m.id || basename(kitDir),
    label: m.label || basename(kitDir),
    description: m.description || '',
    hooksDir: h.dir || KIT_DEFAULTS.hooks,
    schemasDir: h.schemas || KIT_DEFAULTS.schemas,
    settingsFile: h.settings || KIT_DEFAULTS.settings,
    skillsDir: (m.skills && m.skills.dir) || KIT_DEFAULTS.skills,
  };
}

// Provision one kit into a worktree: the kit tree itself under .claude/kits/,
// plus whatever it declares — hooks/, schemas/, skills/*, settings fragment.
export async function provisionKit({ kitDir, kitId, worktreePath, conflicts, written }) {
  const man = await readKitManifest(kitDir);
  const claudeDir = join(worktreePath, '.claude');
  const opts = { owner: kitId, conflicts, written };
  await copyTree(kitDir, join(claudeDir, 'kits', kitId), opts);
  await copyTree(join(kitDir, man.hooksDir), join(claudeDir, 'hooks'), opts);
  await copyTree(join(kitDir, man.schemasDir), join(claudeDir, 'schemas'), opts);
  let skillDirs = [];
  try {
    skillDirs = (await readdir(join(kitDir, man.skillsDir), { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* kit ships no skills */ }
  for (const name of skillDirs) {
    await copyTree(join(kitDir, man.skillsDir, name), join(claudeDir, 'skills', name), opts);
  }
  try {
    await mergeHooks(worktreePath, JSON.parse(await readFile(join(kitDir, man.settingsFile), 'utf8')));
  } catch { /* kit ships no settings fragment */ }
  return { id: kitId, skills: skillDirs };
}
```

Then rewire `provisionPack` so kits go through `provisionKit` and every copy shares one `conflicts`/`written` pair:

```js
export async function provisionPack({ packsDir, pack, skills = [], kits = [], hooks = false, worktreePath }) {
  if (!safeId(pack)) throw new Error(`invalid pack id: ${pack}`);
  const packDir = join(packsDir, pack);
  const out = { skills: [], kits: [], hooks: false, kitSkills: [], conflicts: [] };
  const written = new Map();
  const opts = (owner) => ({ owner, conflicts: out.conflicts, written });

  for (const id of skills) {
    if (!safeId(id)) continue;
    const { copied } = await copyTree(join(packDir, 'skills', id), join(worktreePath, '.claude', 'skills', id), opts(id));
    if (copied || await exists(join(packDir, 'skills', id))) out.skills.push(id);
  }
  for (const id of kits) {
    if (!safeId(id)) continue;
    if (!await exists(join(packDir, 'kits', id))) continue;
    const r = await provisionKit({ kitDir: join(packDir, 'kits', id), kitId: id, worktreePath, conflicts: out.conflicts, written });
    out.kits.push(id);
    out.kitSkills.push(...r.skills);
  }
  if (hooks) {
    const cat = JSON.parse(await readFile(join(packDir, 'catalog.json'), 'utf8'));
    const h = cat.hooks;
    if (h) {
      const claudeDir = join(worktreePath, '.claude');
      const o = opts(h.id || `${pack}-gates`);
      if (h.dir) await copyTree(join(packDir, h.dir), join(claudeDir, 'hooks'), o);
      if (h.schemas) await copyTree(join(packDir, h.schemas), join(claudeDir, 'schemas'), o);
      if (h.settings) await mergeHooks(worktreePath, JSON.parse(await readFile(join(packDir, h.settings), 'utf8')));
      out.hooks = true;
    }
  }
  if (out.skills.length || out.kits.length || out.hooks) await ensureHidden(worktreePath);
  return out;
}
```

Add the small helper next to `safeId` (line 5) and drop the now-unused `cp` import:

```js
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/packs.mjs lib/packs.test.mjs
git commit -m "feat(packs): kits carry their own hooks, skills and settings"
```

---

### Task 6: Provision record

**Files:**
- Modify: `lib/packs.mjs` (add the two functions), `lib/actions.mjs:147-165` (`/api/launch`)
- Test: `lib/packs.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `writeProvisionRecord(worktreePath, selections) → Promise<string>` (the file path). Shape on disk:
    `{ at: <ISO string>, selections: [{ pack, skills, kits, hooks }] }`.
  - `readProvisionRecord(worktreePath) → Promise<object|null>` — `null` when absent or malformed.

- [ ] **Step 1: Write the failing tests**

Append to `lib/packs.test.mjs` (extend the import with `writeProvisionRecord, readProvisionRecord`):

```js
test('provision record round-trips the selections', async () => {
  const wt = await tmp('forest-wt-');
  const selections = [{ pack: 'hektor', skills: [], kits: ['flaky-triage-kit'], hooks: true }];
  const file = await writeProvisionRecord(wt, selections);
  assert.ok(file.endsWith(join('.claude', '.forest-provision.json')));
  const rec = await readProvisionRecord(wt);
  assert.deepEqual(rec.selections, selections);
  assert.ok(!Number.isNaN(Date.parse(rec.at)));
});

test('readProvisionRecord returns null for a worktree that has none', async () => {
  assert.equal(await readProvisionRecord(await tmp('forest-wt-')), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/packs.test.mjs`
Expected: FAIL — `writeProvisionRecord is not exported`.

- [ ] **Step 3: Implement**

In `lib/packs.mjs`:

```js
const PROVISION_FILE = '.forest-provision.json';

// What this worktree was provisioned with — makes a worktree self-describing
// and makes "repair" a replay of a recorded input instead of a guess.
export async function writeProvisionRecord(worktreePath, selections) {
  const file = join(worktreePath, '.claude', PROVISION_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ at: new Date().toISOString(), selections }, null, 2)}\n`);
  return file;
}

export async function readProvisionRecord(worktreePath) {
  try { return JSON.parse(await readFile(join(worktreePath, '.claude', PROVISION_FILE), 'utf8')); }
  catch { return null; }
}
```

In `lib/actions.mjs`, extend the import from `./packs.mjs` to
`import { provisionPack, writeProvisionRecord, readProvisionRecord } from './packs.mjs';`
and inside the `/api/launch` handler, right after the `for (const s of sel)` loop completes:

```js
            await writeProvisionRecord(path, sel);
            if (provisioned.conflicts.length) {
              for (const c of provisioned.conflicts) {
                ctx.journal.add({ cmd: `collision: ${c.path} (${c.incoming} ≠ ${c.existing}) — kept existing`, cwd: path, mode });
              }
            }
```

Also collect conflicts into the accumulator declared above the loop:

```js
          provisioned = { skills: [], kits: [], hooks: false, conflicts: [] };
```

and inside the loop, after the existing pushes:

```js
              provisioned.conflicts.push(...r.conflicts);
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/packs.mjs lib/actions.mjs lib/packs.test.mjs
git commit -m "feat(packs): record what a worktree was provisioned with"
```

---

### Task 7: Session scope resolver

**Files:**
- Create: `lib/session-scope.mjs`
- Test: `lib/session-scope.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (pure module, filesystem only).
- Produces:
  - `resolveHookFile(command: string, worktreePath: string, home?: string) → string|null`
  - `settingsSources(worktreePath: string, userSettingsPath?: string) → Promise<Array<{ file: string, json: object }>>`
  - `resolveSessionScope(worktreePath: string, opts?: { userSettingsPath?: string }) → Promise<{ active: Hook[], missing: Hook[], inline: Hook[], sources: string[] }>`
    where `Hook = { event, matcher, command, source, file? }`.

- [ ] **Step 1: Write the failing tests**

Create `lib/session-scope.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveHookFile, resolveSessionScope } from './session-scope.mjs';

const tmp = (p) => mkdtemp(join(tmpdir(), p));

const settings = (hooks) => JSON.stringify({ hooks });
const bashHook = (command) => ({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] });

test('resolveHookFile expands $CLAUDE_PROJECT_DIR and strips quotes', () => {
  assert.equal(
    resolveHookFile('"$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"', '/wt'),
    '/wt/.claude/hooks/x.sh');
  assert.equal(
    resolveHookFile('${CLAUDE_PROJECT_DIR}/.claude/hooks/y.sh --flag', '/wt'),
    '/wt/.claude/hooks/y.sh');
});

test('resolveHookFile expands ~ and returns null for inline commands', () => {
  assert.equal(resolveHookFile('~/.claude/hooks/z.sh', '/wt', '/home/u'), '/home/u/.claude/hooks/z.sh');
  assert.equal(resolveHookFile('jq -r .cwd', '/wt'), null);
});

test('resolveSessionScope reports an ancestor-registered hook that is missing', async () => {
  const parent = await tmp('forest-parent-');
  await mkdir(join(parent, '.claude'), { recursive: true });
  await writeFile(join(parent, '.claude', 'settings.json'),
    settings(bashHook('"$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.sh"')));
  const wt = join(parent, 'nested', 'wt');
  await mkdir(wt, { recursive: true });

  const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
  assert.equal(scope.active.length, 0);
  assert.equal(scope.missing.length, 1);
  assert.equal(scope.missing[0].file, join(wt, '.claude', 'hooks', 'commit-gate.sh'));
  assert.equal(scope.missing[0].source, join(parent, '.claude', 'settings.json'));
});

test('resolveSessionScope counts a provisioned hook as active', async () => {
  const parent = await tmp('forest-parent-');
  await mkdir(join(parent, '.claude'), { recursive: true });
  await writeFile(join(parent, '.claude', 'settings.json'),
    settings(bashHook('"$CLAUDE_PROJECT_DIR/.claude/hooks/commit-gate.sh"')));
  const wt = join(parent, 'nested', 'wt');
  await mkdir(join(wt, '.claude', 'hooks'), { recursive: true });
  await writeFile(join(wt, '.claude', 'hooks', 'commit-gate.sh'), '#!/bin/sh\n');
  await chmod(join(wt, '.claude', 'hooks', 'commit-gate.sh'), 0o755);

  const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
  assert.equal(scope.active.length, 1);
  assert.equal(scope.missing.length, 0);
});

test('resolveSessionScope counts the same registration once across settings files', async () => {
  const wt = await tmp('forest-wt-');
  await mkdir(join(wt, '.claude'), { recursive: true });
  const same = settings(bashHook('"$CLAUDE_PROJECT_DIR/.claude/hooks/dup.sh"'));
  await writeFile(join(wt, '.claude', 'settings.json'), same);
  await writeFile(join(wt, '.claude', 'settings.local.json'), same);
  const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
  assert.equal(scope.missing.length, 1);
});

test('resolveSessionScope classifies an inline command separately', async () => {
  const wt = await tmp('forest-wt-');
  await mkdir(join(wt, '.claude'), { recursive: true });
  await writeFile(join(wt, '.claude', 'settings.json'), settings(bashHook('jq -r .tool_name')));
  const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
  assert.equal(scope.inline.length, 1);
  assert.equal(scope.missing.length, 0);
});

test('resolveSessionScope lists the user settings file once', async () => {
  const wt = await tmp('forest-wt-');
  const user = join(await tmp('forest-user-'), 'settings.json');
  await writeFile(user, settings(bashHook('/absolute/hook.sh')));
  const scope = await resolveSessionScope(wt, { userSettingsPath: user });
  assert.equal(scope.sources.filter((s) => s === user).length, 1);
  assert.equal(scope.missing.length, 1);
  assert.equal(scope.missing[0].file, '/absolute/hook.sh');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/session-scope.test.mjs`
Expected: FAIL — cannot find module `./session-scope.mjs`.

- [ ] **Step 3: Implement `lib/session-scope.mjs`**

```js
// session-scope.mjs — what a Claude Code session started in a worktree will
// actually load, and whether each registered hook resolves to a real file.
//
// Claude Code merges .claude/settings.json + settings.local.json from the
// session directory AND every ancestor directory, then the user-level file.
// Hook commands are written against $CLAUDE_PROJECT_DIR, which points at the
// session directory — so a hook registered by an ancestor repo resolves into
// the worktree, where the script usually does not exist. That mismatch is
// non-blocking at runtime (exit 127), which is exactly why it goes unnoticed.
import { readFile, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function key(file) {
  try { return await realpath(file); } catch { return file; }
}

// First token of a hook command with $CLAUDE_PROJECT_DIR and ~ expanded.
// Returns null when the command is not a file invocation (inline shell, a bare
// executable name) — those are reported, never counted as missing.
export function resolveHookFile(command, worktreePath, home = homedir()) {
  const raw = String(command || '').trim();
  const m = raw.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  if (!m) return null;
  let tok = m[1] ?? m[2] ?? m[3];
  tok = tok.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g, worktreePath);
  if (tok === '~') tok = home;
  else if (tok.startsWith('~/')) tok = join(home, tok.slice(2));
  return isAbsolute(tok) ? tok : null;
}

// Every settings file that applies to a session rooted at worktreePath, in
// merge order, deduplicated by real path (the worktree root lives under $HOME,
// so the user file is reachable both as an ancestor and as itself).
export async function settingsSources(worktreePath, userSettingsPath) {
  const dirs = [];
  for (let d = worktreePath; ; d = dirname(d)) {
    dirs.push(d);
    if (dirname(d) === d) break;
  }
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    for (const name of SETTINGS_FILES) {
      const file = join(dir, '.claude', name);
      const json = await readJson(file);
      if (!json) continue;
      const k = await key(file);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ file, json });
    }
  }
  const userFile = userSettingsPath || join(homedir(), '.claude', 'settings.json');
  const userJson = await readJson(userFile);
  if (userJson) {
    const k = await key(userFile);
    if (!seen.has(k)) { seen.add(k); out.push({ file: userFile, json: userJson }); }
  }
  return out;
}

export async function resolveSessionScope(worktreePath, { userSettingsPath } = {}) {
  const sources = await settingsSources(worktreePath, userSettingsPath);
  const active = [], missing = [], inline = [];
  const seen = new Set();
  for (const { file, json } of sources) {
    for (const [event, blocks] of Object.entries(json.hooks || {})) {
      for (const block of blocks || []) {
        const matcher = block.matcher || '*';
        for (const h of block.hooks || []) {
          const id = `${event}|${matcher}|${h.command}`;
          if (seen.has(id)) continue;            // Claude Code runs a duplicate registration once
          seen.add(id);
          const rec = { event, matcher, command: h.command, source: file };
          const resolved = resolveHookFile(h.command, worktreePath);
          if (!resolved) { inline.push(rec); continue; }
          rec.file = resolved;
          try { await stat(resolved); active.push(rec); } catch { missing.push(rec); }
        }
      }
    }
  }
  return { active, missing, inline, sources: sources.map((s) => s.file) };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS — 7 new tests included.

- [ ] **Step 5: Verify against the real defect this was written for**

Run:

```bash
node -e "import('./lib/session-scope.mjs').then(async (m) => {
  const s = await m.resolveSessionScope('/Users/egecan.sen/sahibinden/repo/web-test/.forest/wt/tech-WEBT-254523');
  console.log('active', s.active.length, 'missing', s.missing.length);
  console.log(s.missing.map((h) => h.command).join('\n'));
})"
```

Expected: `missing` includes `commit-gate.sh`, `destructive-command-gate.sh`, `observe.sh` and `delivery-gate.sh`, each with the main repo's `settings.json` as `source`. This is the bug that ran unnoticed from 2026-06-29 to 2026-07-29.

- [ ] **Step 6: Commit**

```bash
git add lib/session-scope.mjs lib/session-scope.test.mjs
git commit -m "feat(scope): resolve a session's hooks and report the missing ones"
```

---

### Task 8: Wire the resolver into launch, discovery and repair

**Files:**
- Modify: `lib/actions.mjs` (launch response + two new routes), `lib/discover.mjs:80-90` (record field)
- Test: `lib/discover.test.mjs`

**Interfaces:**
- Consumes: `resolveSessionScope` (Task 7), `readProvisionRecord`/`provisionPack` (Tasks 5-6).
- Produces:
  - `/api/launch` response grows `scope: { active: number, missing: Array<{ command, source }> }`.
  - `POST /api/worktree/scope { path }` → `{ active, missing, inline, sources }` (counts plus the missing entries).
  - `POST /api/worktree/repair { path }` → `{ ok: true, provisioned, scope }` or `{ error: 'no provision record' }` with status 409.
  - Each worktree record from `buildWorktreeRecord` grows `scope: { active: number, missing: number }`.

- [ ] **Step 1: Write the failing test**

Append to `lib/discover.test.mjs`:

```js
test('buildWorktreeRecord reports the session scope of a worktree', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'forest-scope-'));
  await mkdir(join(parent, '.claude'), { recursive: true });
  await writeFile(join(parent, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh"' }] }] },
  }));
  const wt = join(parent, 'wt');
  await mkdir(wt, { recursive: true });

  const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/file.json' });
  assert.equal(scope.missing.length, 1);   // the shape buildWorktreeRecord summarises
});
```

(The record itself is produced inside a git-backed snapshot; assert the resolver contract here and verify the field manually in Step 5.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/discover.test.mjs`
Expected: FAIL — `resolveSessionScope is not defined` (import missing).

- [ ] **Step 3: Implement**

In `lib/discover.test.mjs`, add the imports the new test needs (`mkdtemp`, `mkdir`, `writeFile`, `tmpdir`, `join`, and `resolveSessionScope` from `./session-scope.mjs`).

In `lib/discover.mjs`, import the resolver and attach the summary inside `buildWorktreeRecord`, next to the existing `agent` lookup:

```js
import { resolveSessionScope } from './session-scope.mjs';
...
  const scopeFull = await safe(() => resolveSessionScope(path), { active: [], missing: [], inline: [], sources: [] });
  const scope = { active: scopeFull.active.length, missing: scopeFull.missing.length };
```

and add `scope,` to the returned record object.

In `lib/actions.mjs`, import the resolver:

```js
import { resolveSessionScope } from './session-scope.mjs';
```

In the `/api/launch` handler, after `writeProvisionRecord`, compute and return the scope:

```js
        const scope = await resolveSessionScope(path);
        if (scope.missing.length) {
          ctx.journal.add({ cmd: `scope: ${scope.missing.length} hook script(s) registered but missing`, cwd: path, mode });
        }
```

and include it in both success responses:

```js
        return r && r.ok
          ? sendJson(res, { ok: true, action: r.action, provisioned, scope: { active: scope.active.length, missing: scope.missing.map((h) => ({ command: h.command, source: h.source })) } })
          : sendJson(res, { error: (r && r.error) || 'failed to open Terminal' }, 500);
```

Add the two routes next to the other `/api/worktree/*` branches:

```js
      if (url === '/api/worktree/scope') {
        const { path } = body;
        const s = await resolveSessionScope(path);
        return sendJson(res, {
          active: s.active.length,
          inline: s.inline.length,
          sources: s.sources,
          missing: s.missing.map((h) => ({ command: h.command, source: h.source, file: h.file })),
        });
      }

      if (url === '/api/worktree/repair') {
        const { path } = body;
        const rec = await readProvisionRecord(path);
        if (!rec || !Array.isArray(rec.selections) || !rec.selections.length) {
          return sendJson(res, { error: 'no provision record' }, 409);
        }
        const provisioned = { skills: [], kits: [], hooks: false, conflicts: [] };
        for (const s of rec.selections) {
          const r = await provisionPack({ packsDir: ctx.config.packsDir, pack: s.pack, skills: s.skills || [], kits: s.kits || [], hooks: !!s.hooks, worktreePath: path });
          provisioned.skills.push(...r.skills);
          provisioned.kits.push(...r.kits);
          provisioned.conflicts.push(...r.conflicts);
          if (r.hooks) provisioned.hooks = true;
        }
        const scope = await resolveSessionScope(path);
        ctx.journal.add({ cmd: `repair: re-provisioned ${provisioned.kits.length} kit(s); missing ${scope.missing.length}`, cwd: path, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, provisioned, scope: { active: scope.active.length, missing: scope.missing.length } });
      }
```

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: PASS.

- [ ] **Step 5: Verify against a real worktree**

Run: `npm start`, then in a second shell:

```bash
curl -s localhost:5577/api/worktree/scope -X POST -H 'content-type: application/json' \
  -d '{"path":"/Users/egecan.sen/sahibinden/repo/web-test/.forest/wt/tech-WEBT-254523"}' | head -30
```

Expected: `active` > 0, `missing` lists the four Hektor gates with the main repo's settings file as `source`.

- [ ] **Step 6: Commit**

```bash
git add lib/actions.mjs lib/discover.mjs lib/discover.test.mjs
git commit -m "feat(scope): surface session scope on launch, discovery and repair"
```

---

### Task 9: UI — gate badge, launch warning, scope preview, repair

**Files:**
- Modify: `public/app.js:43-47` (badges), `public/app.js:73` (row template), `public/app.js:418-463` (picker), `public/index.html:98-103` (picker footer), `public/style.css`

**Interfaces:**
- Consumes: `w.scope` from discovery, `/api/worktree/scope`, `/api/worktree/repair`, and the `scope` field on the `/api/launch` response (Task 8).
- Produces: no new module exports; UI only.
- **Shape warning:** `missing` is a **number** on the discovery record (`w.scope.missing`) and an **array** on the `/api/launch` and `/api/worktree/scope` responses (`r.scope.missing.length`). Both appear in this task; do not mix them.

- [ ] **Step 1: Add the gate badge**

In `public/app.js`, after `statusBadge` (line 47):

```js
function gateBadge(w) {
  const s = w.scope;
  if (!s || (!s.active && !s.missing)) return '';
  return s.missing
    ? `<span class="badge b-stale" title="hook scripts registered but absent — the gates are not running">gates ${s.active} · missing ${s.missing}</span>`
    : `<span class="badge b-clean" title="every registered hook resolves to a file">gates ${s.active}</span>`;
}
```

In the row template on line 73:

```js
    <div class="col-status">${statusBadge(w)}${gateBadge(w)}</div>
```

- [ ] **Step 2: Verify the badge in the browser**

Run: `npm start`, open `http://localhost:5577`.
Expected: worktrees provisioned with gates show `gates N`; `tech-WEBT-254523` shows `gates … · missing 16` in the stale (amber) style.

- [ ] **Step 3: Add the picker scope preview**

In `public/index.html`, replace line 101 with:

```html
        <span id="pk-count" class="pk-count"></span>
        <span id="pk-scope" class="pk-scope"></span>
```

In `public/style.css`, next to the `.pk-count` rule:

```css
.pk-scope { font-size: 12px; opacity: .65; margin-left: 10px; }
.pk-scope.warn { opacity: 1; color: var(--amber, #d08a2a); }
```

In `public/app.js`, inside `openPicker(path)` after `updatePickerCount();`:

```js
  refreshPickerScope(path);
```

and add the loader below `updatePickerCount`:

```js
// What the session will load today — before provisioning anything. Makes the
// remaining ~/.claude inheritance visible instead of implicit.
async function refreshPickerScope(path) {
  const el = $('#pk-scope');
  el.textContent = '';
  el.classList.remove('warn');
  const s = await api('/api/worktree/scope', { path });
  if (!s || s.error) return;
  el.textContent = s.missing.length
    ? `${s.active} hooks active · ${s.missing.length} missing`
    : `${s.active} hooks active · ${s.sources.length} settings source(s)`;
  if (s.missing.length) el.classList.add('warn');
}
```

- [ ] **Step 4: Warn at launch when a hook is missing**

In `startSession()`, replace the final `toast(...)` call with:

```js
  const miss = r.scope && r.scope.missing ? r.scope.missing.length : 0;
  if (miss) toast(`${provMsg}Launching Claude — ${miss} registered hook script(s) missing`);
  else toast(r.action === 'focused' ? 'Claude already running — Terminal brought to front' : `${provMsg}Launching Claude…`);
```

- [ ] **Step 5: Add the repair action**

Follow the existing row-action pattern: a `data-act` button in the row template (`public/app.js:79-83`) dispatched by `doAction` (line 263). Add the button after the "Launch Claude" one on line 80, rendered only when the worktree reports missing hooks:

```js
      ${w.scope && w.scope.missing ? `<button title="Repair ${w.scope.missing} missing hook script(s)" data-act="repair" data-path="${enc}">🩹</button>` : ''}
```

And in `doAction`, next to the other branches (after the `open-cursor` case on line 266):

```js
  if (act === 'repair') {
    const r = await api('/api/worktree/repair', { path });
    if (!r || r.error) { toast(`Repair failed: ${(r && r.error) || 'server unreachable'} — open the picker and re-provision`); return; }
    toast(`Repaired · ${r.scope.active} hooks active, ${r.scope.missing} missing`);
    return;
  }
```

- [ ] **Step 6: Verify the full loop in the browser**

1. `npm start`, open the UI.
2. Open the picker on a worktree → the footer shows `N hooks active · M settings source(s)`.
3. Select the flaky-triage kit → launch → toast reports provisioned counts and any missing hooks.
4. On a worktree showing `missing`, press Repair → badge turns to `gates N` with no missing.

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/index.html public/style.css
git commit -m "feat(ui): gate badge, scope preview and hook repair"
```

---

## Done criteria

- `node --test` green.
- A worktree created through the UI lands under `~/.forest/wt/<repo>/<branch>` and its scope preview lists only `~/.claude` plus its own provisioned settings.
- A kit with `hooks/` and `settings.hooks.json` provisions both without a manifest.
- Two kits shipping different versions of the same file produce a journal `collision:` line and leave the destination intact.
- `tech-WEBT-254523` shows a non-zero `missing` badge until repaired — the regression that motivated this plan is now visible in the UI.
