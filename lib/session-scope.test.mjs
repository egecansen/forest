import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveHookFile, resolveSessionScope, resolveCursorScope } from './session-scope.mjs';

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
  try {
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
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('resolveSessionScope counts a provisioned hook as active', async () => {
  const parent = await tmp('forest-parent-');
  try {
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
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('resolveSessionScope counts the same registration once across settings files', async () => {
  const wt = await tmp('forest-wt-');
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    const same = settings(bashHook('"$CLAUDE_PROJECT_DIR/.claude/hooks/dup.sh"'));
    await writeFile(join(wt, '.claude', 'settings.json'), same);
    await writeFile(join(wt, '.claude', 'settings.local.json'), same);
    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.missing.length, 1);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test('resolveSessionScope classifies an inline command separately', async () => {
  const wt = await tmp('forest-wt-');
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(join(wt, '.claude', 'settings.json'), settings(bashHook('jq -r .tool_name')));
    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.inline.length, 1);
    assert.equal(scope.missing.length, 0);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test('resolveSessionScope lists the user settings file once', async () => {
  const wt = await tmp('forest-wt-');
  const userDir = await tmp('forest-user-');
  try {
    const user = join(userDir, 'settings.json');
    await writeFile(user, settings(bashHook('/absolute/hook.sh')));
    const scope = await resolveSessionScope(wt, { userSettingsPath: user });
    assert.equal(scope.sources.filter((s) => s === user).length, 1);
    assert.equal(scope.missing.length, 1);
    assert.equal(scope.missing[0].file, '/absolute/hook.sh');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  }
});

test('resolveSessionScope tolerates a hook block that is not wrapped in an array', async () => {
  const wt = await tmp('forest-wt-');
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(join(wt, '.claude', 'settings.json'),
      settings({ PreToolUse: { matcher: 'Bash', hooks: [{ type: 'command', command: '/absolute/hook.sh' }] } }));
    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.active.length, 0);
    assert.equal(scope.missing.length, 0);
    assert.equal(scope.inline.length, 0);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test('resolveSessionScope tolerates a hooks field that is not an array', async () => {
  const wt = await tmp('forest-wt-');
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(join(wt, '.claude', 'settings.json'),
      settings({ PreToolUse: [{ matcher: 'Bash', hooks: { type: 'command', command: '/absolute/hook.sh' } }] }));
    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.active.length, 0);
    assert.equal(scope.missing.length, 0);
    assert.equal(scope.inline.length, 0);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

// --- dispatcher expansion (spec: docs/superpowers/specs/2026-08-05-hook-dispatcher-design.md) ---

test('a dispatcher registration expands to its .d entries', async () => {
  const wt = await tmp('forest-wt-');
  try {
    const hooks = join(wt, '.claude', 'hooks');
    await mkdir(join(hooks, 'PreToolUse-Bash.d'), { recursive: true });
    await writeFile(join(hooks, 'dispatch.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(hooks, 'ok.sh'), '#!/bin/sh\n');
    await chmod(join(hooks, 'ok.sh'), 0o755);
    await symlink('../ok.sh', join(hooks, 'PreToolUse-Bash.d', '10-ok.sh'));
    await symlink('../gone.sh', join(hooks, 'PreToolUse-Bash.d', '20-gone.sh'));
    await writeFile(join(wt, '.claude', 'settings.local.json'),
      settings(bashHook('"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" PreToolUse-Bash')));

    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.active.length, 1, 'one resolvable entry');
    assert.equal(scope.active[0].file, join(hooks, 'ok.sh'), 'active file is the symlink target');
    assert.equal(scope.missing.length, 1, 'one broken entry');
    assert.equal(scope.missing[0].file, join(hooks, 'gone.sh'), 'missing names the absent target');
    assert.equal(scope.missing[0].source, join(hooks, 'PreToolUse-Bash.d', '20-gone.sh'),
      'source is the symlink to fix');
    assert.ok(!scope.active.some((h) => h.file.endsWith('dispatch.sh')),
      'the dispatcher itself is not double-counted as a gate');
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('a dispatcher registration with no .d directory contributes nothing', async () => {
  const wt = await tmp('forest-wt-');
  try {
    const hooks = join(wt, '.claude', 'hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(join(hooks, 'dispatch.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(wt, '.claude', 'settings.local.json'),
      settings(bashHook('"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" PreToolUse-Bash')));
    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.active.length, 0);
    assert.equal(scope.missing.length, 0);
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('a linked git worktree also loads the primary repo settings', async () => {
  const repo = await tmp('forest-repo-'), base = await tmp('forest-wtbase-');
  try {
    // Primary checkout: a .git DIRECTORY with a worktrees/ entry, and a stale
    // registration in its settings.local.json whose script exists nowhere.
    await mkdir(join(repo, '.git', 'worktrees', 'wt1'), { recursive: true });
    await mkdir(join(repo, '.claude'), { recursive: true });
    await writeFile(join(repo, '.claude', 'settings.local.json'),
      settings(bashHook('"$CLAUDE_PROJECT_DIR/.claude/hooks/ghost.sh"')));
    // Linked worktree far away from the repo: .git is a FILE naming the gitdir.
    const wt = join(base, 'wt1');
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt1')}\n`);

    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.missing.length, 1,
      'the primary repo registration reaches the worktree session and must be counted');
    assert.equal(scope.missing[0].file, join(wt, '.claude', 'hooks', 'ghost.sh'),
      'resolved against the worktree, where the session runs');
    assert.equal(scope.missing[0].source, join(repo, '.claude', 'settings.local.json'));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

test('a registered dispatcher that is itself absent reports as missing', async () => {
  const wt = await tmp('forest-wt-');
  try {
    await mkdir(join(wt, '.claude'), { recursive: true });
    await writeFile(join(wt, '.claude', 'settings.local.json'),
      settings(bashHook('"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" PreToolUse-Bash')));
    const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
    assert.equal(scope.missing.length, 1);
    assert.equal(scope.missing[0].file, join(wt, '.claude', 'hooks', 'dispatch.sh'));
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('resolveCursorScope: no .cursor/hooks.json → empty, file null, never throws', async () => {
  const wt = await tmp('forest-cscope-');
  try {
    assert.deepEqual(await resolveCursorScope(wt), { active: [], missing: [], file: null });
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('resolveCursorScope: relative ./ commands are stat-ed, others count as active', async () => {
  const wt = await tmp('forest-cscope-');
  try {
    await mkdir(join(wt, '.cursor', 'hooks'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks', 'present.sh'), '#!/bin/sh\n');
    await writeFile(join(wt, '.cursor', 'hooks.json'), JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: './.cursor/hooks/present.sh', timeout: 10 },
          { command: './.cursor/hooks/gone.sh --strict', timeout: 10 },
        ],
        subagentStart: { command: 'hektor-registry', timeout: 5 },
        afterFileEdit: 'not-an-object',
      },
    }));
    const s = await resolveCursorScope(wt);
    assert.equal(s.file, join(wt, '.cursor', 'hooks.json'));
    assert.deepEqual(s.active.map((h) => [h.event, h.command]), [
      ['beforeShellExecution', './.cursor/hooks/present.sh'],
      ['subagentStart', 'hektor-registry'],
    ]);
    assert.equal(s.active[0].file, join(wt, '.cursor', 'hooks', 'present.sh'));
    assert.equal(s.active[1].file, null);
    assert.deepEqual(s.missing, [
      { event: 'beforeShellExecution', command: './.cursor/hooks/gone.sh --strict', file: join(wt, '.cursor', 'hooks', 'gone.sh') },
    ]);
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('resolveCursorScope: a hooks.json that is not JSON reads as absent', async () => {
  const wt = await tmp('forest-cscope-');
  try {
    await mkdir(join(wt, '.cursor'), { recursive: true });
    await writeFile(join(wt, '.cursor', 'hooks.json'), '{ nope');
    assert.deepEqual(await resolveCursorScope(wt), { active: [], missing: [], file: null });
  } finally { await rm(wt, { recursive: true, force: true }); }
});
