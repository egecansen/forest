import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorktreeList, parseStatus, parseAheadBehind, extractTicket, detectOwner,
} from './git.mjs';

test('parseWorktreeList parses branch and detached blocks', () => {
  const text = [
    'worktree /repo/web-test',
    'HEAD cdf9228c51',
    'branch refs/heads/tech/WEBT-249514',
    '',
    'worktree /repo/web-test/.cursor/worktrees/web-test/vys8',
    'HEAD ac9746f574',
    'detached',
    '',
  ].join('\n');
  const wts = parseWorktreeList(text);
  assert.equal(wts.length, 2);
  assert.equal(wts[0].path, '/repo/web-test');
  assert.equal(wts[0].branch, 'tech/WEBT-249514');
  assert.equal(wts[0].detached, false);
  assert.equal(wts[1].branch, null);
  assert.equal(wts[1].detached, true);
});

test('parseStatus counts changed/staged/dirty', () => {
  const text = ' M src/a.js\nA  src/b.js\n?? src/c.js\n';
  const s = parseStatus(text);
  assert.equal(s.dirty, true);
  assert.equal(s.changed, 3);
  assert.equal(s.staged, 1); // only "A " has an index-stage change
});

test('parseStatus on clean tree', () => {
  assert.deepEqual(parseStatus(''), { changed: 0, staged: 0, dirty: false });
});

test('parseAheadBehind maps left=behind right=ahead', () => {
  assert.deepEqual(parseAheadBehind('2\t3\n'), { ahead: 3, behind: 2 });
  assert.deepEqual(parseAheadBehind('0\t0'), { ahead: 0, behind: 0 });
});

test('extractTicket pulls JIRA token from branch', () => {
  assert.equal(extractTicket('tech/SUI-238145'), 'SUI-238145');
  assert.equal(extractTicket('fun/QUICKLY-245363'), 'QUICKLY-245363');
  assert.equal(extractTicket('master'), null);
});

test('detectOwner classifies by path', () => {
  assert.equal(detectOwner('/r/web-test/.cursor/worktrees/web-test/vys8'), 'cursor');
  assert.equal(detectOwner('/r/web-test/.claude/worktrees/no-flag-map'), 'claude');
  assert.equal(detectOwner('/r/web-test'), 'user');
});
