# Hook Dispatcher Implementation Plan (forest phase)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything forest wires into a worktree registers one permanent
dispatcher command per (event, matcher); gate scripts are enumerated from
`.claude/hooks/<slug>.d/` symlinks at call time, so registrations can never go
stale and disk repairs reach live sessions.

**Architecture:** `matcherSlug` + `ensureDispatcher` + `registerDispatch` in
`lib/packs.mjs` (successor to the module-private `mergeHooks`), wired into the
two paths forest owns — `provisionKit` without `install.sh` and
`provisionPack`'s `hooks: true`. `lib/session-scope.mjs` learns to expand a
dispatcher registration into its `.d` entries so the launch guard and badge
keep entry-level granularity.

**Tech Stack:** Plain Node (`node:test` + `node:assert/strict`), no
dependencies, POSIX sh for the dispatcher.

Spec: `docs/superpowers/specs/2026-08-05-hook-dispatcher-design.md`

## Global Constraints

- **Never run `git commit` or `git push`.** Files stay uncommitted; suggest a
  message at the end.
- No new npm dependencies. No rewriting of any gate script — symlinks must
  leave `dirname "${BASH_SOURCE[0]}"` lib-loading working (dispatcher
  `realpath`-resolves before exec).
- The kit-with-`install.sh` path in `provisionKit` is untouched (phase 2,
  `SKLS/hektor`).
- Forest edits only the worktree `settings.local.json` it owns — never
  `settings.json`, never files outside the worktree.
- Run `node --test lib/<file>.test.mjs` per task, `npm test` at the end.

---

### Task 1: `matcherSlug` and the dispatcher asset

**Files:** `lib/packs.mjs`, `lib/packs.test.mjs`

- [ ] **Step 1: Failing tests**

```js
test('matcherSlug is stable and collision-free for the matchers in use', () => {
  assert.equal(matcherSlug('PreToolUse', 'Bash'), 'PreToolUse-Bash');
  assert.equal(matcherSlug('PreToolUse', 'Write|Edit'), 'PreToolUse-Write_Edit');
  assert.equal(matcherSlug('PostToolUse', 'Edit|Write|Bash'), 'PostToolUse-Edit_Write_Bash');
  assert.equal(matcherSlug('Stop', undefined), 'Stop');
  assert.equal(matcherSlug('Stop', '*'), 'Stop');
});

test('ensureDispatcher writes an executable dispatch.sh once and repairs drift', async () => {
  const wt = await tmp('forest-wt-');
  try {
    const p = await ensureDispatcher(join(wt, '.claude', 'hooks'));
    assert.equal((await stat(p)).mode & 0o111, 0o111);
    const body = await readFile(p, 'utf8');
    await writeFile(p, '#!/bin/sh\nexit 3\n');           // tampered / outdated
    await ensureDispatcher(join(wt, '.claude', 'hooks'));
    assert.equal(await readFile(p, 'utf8'), body);       // rewritten to current
  } finally { await rm(wt, { recursive: true, force: true }); }
});
```

- [ ] **Step 2:** `node --test lib/packs.test.mjs` — FAIL (no such exports).
- [ ] **Step 3: Implement** — `matcherSlug(event, matcher)` returns `event`
  when matcher is falsy or `'*'`, else
  `` `${event}-${matcher.replace(/[^A-Za-z0-9]+/g, '_')}` ``. `DISPATCH_SH`
  is the exact script from the spec (§The dispatcher). `ensureDispatcher(dir)`
  mkdirs, writes when absent or content differs, chmods 0o755, returns the
  path.
- [ ] **Step 4:** Test green.

### Task 2: Dispatcher runtime behaviour (subprocess tests)

**Files:** `lib/packs.test.mjs` only — pins the sh contract before anything
depends on it.

- [ ] **Step 1: Failing tests** — build a fixture `.claude/hooks/` with two
  real scripts (`a.sh` appends to a log then exits 0; `b.sh` exits 2 with
  stderr) and a `PreToolUse-Bash.d/` containing `10-a.sh`, `20-b.sh` relative
  symlinks plus one broken symlink `30-gone.sh -> ../gone.sh`. Run
  `execFile('/bin/sh', [dispatchPath, 'PreToolUse-Bash'], { env: { ...process.env, CLAUDE_PROJECT_DIR: wt } })`
  piping a payload string, and assert:
  - `a.sh` ran and received the payload; exit code is 2 (`b.sh`'s, first
    non-zero wins) and its stderr came through;
  - the broken symlink produced the `is not executable` warning but execution
    reached it only after `a.sh`/`b.sh` (name order);
  - a slug with no `.d` directory exits 0 silently;
  - a script using `dirname "${BASH_SOURCE[0]}"/lib/x.sh` finds its lib when
    invoked through its symlink (the `realpath` guarantee).
- [ ] **Step 2:** FAIL (no dispatcher on disk yet in fixtures — use
  `ensureDispatcher` from Task 1; failures should be assertion-level).
- [ ] **Step 3:** Adjust `DISPATCH_SH` only if an assertion exposes a
  discrepancy. No JS changes expected.
- [ ] **Step 4:** Green.

### Task 3: `registerDispatch` — links, settings line, legacy cleanup

**Files:** `lib/packs.mjs`, `lib/packs.test.mjs`

**Interface:** `registerDispatch(worktreePath, template)` — same call shape as
`mergeHooks` (a parsed settings fragment); replaces it wholesale.

- [ ] **Step 1: Failing tests**

```js
test('registerDispatch links scripts in fragment order and registers one dispatcher line', async () => {
  // fragment: PreToolUse/Bash → commit-gate.sh, destructive-command-gate.sh
  // asserts: .claude/hooks/PreToolUse-Bash.d/{10-commit-gate.sh,20-destructive-command-gate.sh}
  //   are relative symlinks to ../<name>; settings.local.json has exactly one
  //   PreToolUse/Bash hook whose command is
  //   "$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" PreToolUse-Bash;
  //   re-running changes nothing (idempotent).
});

test('registerDispatch strips a superseded per-script registration, same event+matcher only', async () => {
  // settings.local.json pre-seeded with old-style commit-gate.sh line under
  // PreToolUse/Bash AND an unrelated inline `jq -r .cwd` line AND a
  // commit-gate.sh line under a *different* matcher block.
  // After: old-style line gone, inline line survives, other-matcher line survives.
});

test('registerDispatch leaves a non-path command registered verbatim', async () => {
  // fragment entry whose command is inline shell (resolveHookFile → null)
  // is merged as-is, not symlinked.
});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** in `packs.mjs`:
  - `import { resolveHookFile } from './session-scope.mjs';` (no cycle —
    session-scope imports nothing from packs).
  - For each event/matcher block, for each hook entry: resolve the command's
    file against `worktreePath`. Unresolvable → merge verbatim (old
    behaviour). Resolvable → `NN-<basename>` symlink in
    `.claude/hooks/<slug>.d/` pointing at `relative(dDir, resolved)`
    (`unlink` ENOENT-tolerant, then `symlink` — the `.d` tree is wholly
    forest-owned), and remember the basename.
  - After linking: ensure the dispatcher (Task 1), then write the settings
    block — reuse the existing find-matcher/dedupe-by-command merge shape —
    with the single dispatcher command, and filter out of that same
    (event, matcher) block any entry whose command basename is one just
    linked.
  - Delete `mergeHooks`; `registerDispatch` is called from its two call
    sites (Task 4 wires them).
- [ ] **Step 4:** Green.

### Task 4: Wire into `provisionKit` and `provisionPack`

**Files:** `lib/packs.mjs`, `lib/packs.test.mjs`

- [ ] **Step 1: Failing test updates** — the existing convention-kit and
  `hooks: true` provisioning tests assert per-script settings lines today;
  update them to assert dispatcher lines + `.d` symlinks + scripts still
  copied to `.claude/hooks/`. Add one new test: re-provisioning a worktree
  that was provisioned under the old scheme converts it (legacy lines gone).
- [ ] **Step 2:** FAIL against current wiring.
- [ ] **Step 3: Implement** — swap both `mergeHooks(...)` call sites
  (`provisionKit` non-installer path, `provisionPack` `hooks: true` path) to
  `registerDispatch(...)`. `writesHookWiring` needs no change (a parseable
  settings fragment still means wiring gets written).
- [ ] **Step 4:** `node --test lib/packs.test.mjs` fully green.

### Task 5: Scope resolver expands dispatcher registrations

**Files:** `lib/session-scope.mjs`, `lib/session-scope.test.mjs`

- [ ] **Step 1: Failing tests**

```js
test('a dispatcher registration expands to its .d entries', async () => {
  // fixture: dispatch.sh + PreToolUse-Bash.d/{10-ok.sh -> ../ok.sh (exists),
  //   20-gone.sh -> ../gone.sh (broken)} + dispatcher settings line.
  // scope.active includes ok.sh (file = resolved target, source = symlink path);
  // scope.missing includes the broken entry; the dispatcher itself is not
  // double-counted as an active hook.
});

test('a dispatcher registration with no .d directory contributes nothing', async () => { /* … */ });
```

- [ ] **Step 2:** FAIL — today the dispatcher line reports as one active hook.
- [ ] **Step 3: Implement** — in `resolveSessionScope`, when the resolved
  file's basename is `dispatch.sh`: parse the slug (second token of the
  command), `readdir` `<dirname>/<slug>.d`; per entry `stat` (follows links) →
  active with `file` = `realpath`, or missing with `source` = the entry path.
  `lstat`-only entries (dirs, stray files) are skipped. The dispatcher line
  itself is not emitted as a record.
- [ ] **Step 4:** Green. The launch guard (`launchDecision`), repair route,
  and badge consume `scope.missing` unchanged — no edits there; confirm
  `node --test lib/actions.test.mjs` still passes untouched.

### Task 6: Full suite + end-to-end scratch provision

- [ ] **Step 1:** `npm test` — everything green.
- [ ] **Step 2:** Script a scratch run (tmp dir as fake pack with a
  `catalog.json` gate set + one convention kit): `provisionPack`, then
  `resolveSessionScope` on the result — assert every gate active, zero
  missing, exactly one settings line per (event, matcher). Keep it as a test
  in `lib/packs.test.mjs` (integration-style, house precedent exists).
- [ ] **Step 3:** Suggested commit message:
  `feat(hooks): dispatcher + .d-dir provisioning so registrations cannot go stale`
