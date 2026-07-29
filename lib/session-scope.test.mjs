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

test('resolveSessionScope tolerates a hook block that is not wrapped in an array', async () => {
  const wt = await tmp('forest-wt-');
  await mkdir(join(wt, '.claude'), { recursive: true });
  await writeFile(join(wt, '.claude', 'settings.json'),
    settings({ PreToolUse: { matcher: 'Bash', hooks: [{ type: 'command', command: '/absolute/hook.sh' }] } }));
  const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
  assert.equal(scope.active.length, 0);
  assert.equal(scope.missing.length, 0);
  assert.equal(scope.inline.length, 0);
});

test('resolveSessionScope tolerates a hooks field that is not an array', async () => {
  const wt = await tmp('forest-wt-');
  await mkdir(join(wt, '.claude'), { recursive: true });
  await writeFile(join(wt, '.claude', 'settings.json'),
    settings({ PreToolUse: [{ matcher: 'Bash', hooks: { type: 'command', command: '/absolute/hook.sh' } }] }));
  const scope = await resolveSessionScope(wt, { userSettingsPath: '/no/such/user-settings.json' });
  assert.equal(scope.active.length, 0);
  assert.equal(scope.missing.length, 0);
  assert.equal(scope.inline.length, 0);
});
