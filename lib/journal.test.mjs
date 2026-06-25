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

test('add preserves an explicit ts, including ts:0', () => {
  const j = createJournal({ max: 10 });
  const a = j.add({ cmd: 'x', ts: 0 });
  assert.equal(a.ts, 0);
  const b = j.add({ cmd: 'y', ts: 12345 });
  assert.equal(b.ts, 12345);
});

test('add returns the stored entry with a stamped ts when absent', () => {
  const j = createJournal({ max: 10 });
  const e = j.add({ cmd: 'z' });
  assert.equal(e.cmd, 'z');
  assert.equal(typeof e.ts, 'number');
  assert.ok(e.ts > 0);
});

test('recent holds exactly max when given exactly max entries', () => {
  const j = createJournal({ max: 3 });
  for (let i = 0; i < 3; i++) j.add({ cmd: `c${i}` });
  assert.equal(j.recent().length, 3);
});
