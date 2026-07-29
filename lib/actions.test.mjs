import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('worktree creation composes its path via worktreePathFor', async () => {
  const src = await readFile(new URL('./actions.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('worktreePathFor'), 'actions.mjs must use the shared path helper');
  assert.ok(!src.includes('.forest/wt'), 'the .forest/wt literal must live only in config.mjs');
});
