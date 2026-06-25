import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from './journal.mjs';

test('add stores entries and recent returns them newest-last', () => {
  const j = createJournal({ max: 10 });
  j.add({ cmd: 'git fetch' });
  j.add({ cmd: 'git status' });
  const r = j.recent();
  assert.equal(r.length, 2);
  assert.equal(r[1].cmd, 'git status');
  assert.equal(typeof r[1].ts, 'number');
});

test('recent is trimmed to max', () => {
  const j = createJournal({ max: 3 });
  for (let i = 0; i < 5; i++) j.add({ cmd: `c${i}` });
  const r = j.recent();
  assert.equal(r.length, 3);
  assert.equal(r[0].cmd, 'c2'); // oldest kept
  assert.equal(r[2].cmd, 'c4');
});

test('subscribe is notified on add and unsub stops it', () => {
  const j = createJournal({ max: 10 });
  const seen = [];
  const unsub = j.subscribe((e) => seen.push(e.cmd));
  j.add({ cmd: 'a' });
  unsub();
  j.add({ cmd: 'b' });
  assert.deepEqual(seen, ['a']);
});
