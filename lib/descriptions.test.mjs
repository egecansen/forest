import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDescriptions, readDescription, saveDescription, clearDescription,
  descriptionKey, resolveDescription,
} from './descriptions.mjs';

const withRepo = async (fn) => {
  const repo = await mkdtemp(join(tmpdir(), 'forest-desc-'));
  try { return await fn(repo); } finally { await rm(repo, { recursive: true, force: true }); }
};

test('saveDescription/readDescription: roundtrip, persisted to .forest/descriptions.json', async () => {
  await withRepo(async (repo) => {
    assert.equal(await readDescription(repo, 'tech/WEBT-229553'), null);
    await saveDescription(repo, 'tech/WEBT-229553', 'ship the thing');
    assert.equal(await readDescription(repo, 'tech/WEBT-229553'), 'ship the thing');
    const raw = JSON.parse(await readFile(join(repo, '.forest', 'descriptions.json'), 'utf8'));
    assert.deepEqual(raw, { 'tech/WEBT-229553': 'ship the thing' });
  });
});

test('saveDescription: overwrites an existing override in place', async () => {
  await withRepo(async (repo) => {
    await saveDescription(repo, 'b', 'first');
    await saveDescription(repo, 'b', 'second');
    assert.equal(await readDescription(repo, 'b'), 'second');
    assert.deepEqual(await readDescriptions(repo), { b: 'second' });
  });
});

test('saveDescription: an empty string is a real override, not an absence', async () => {
  // "I want this box blank" has to be distinguishable from "I never wrote one",
  // otherwise a deliberate blank silently re-fills from Jira on the next open.
  await withRepo(async (repo) => {
    await saveDescription(repo, 'b', '');
    assert.equal(await readDescription(repo, 'b'), '');
    assert.notEqual(await readDescription(repo, 'b'), null);
  });
});

test('readDescriptions: a missing file reads as empty', async () => {
  await withRepo(async (repo) => {
    assert.deepEqual(await readDescriptions(repo), {});
    assert.equal(await readDescription(repo, 'anything'), null);
  });
});

test('readDescriptions: corrupt JSON reads as empty rather than throwing', async () => {
  await withRepo(async (repo) => {
    await mkdir(join(repo, '.forest'), { recursive: true });
    await writeFile(join(repo, '.forest', 'descriptions.json'), '{not json');
    assert.deepEqual(await readDescriptions(repo), {});
  });
});

test('readDescriptions: a non-object payload reads as empty', async () => {
  await withRepo(async (repo) => {
    await mkdir(join(repo, '.forest'), { recursive: true });
    await writeFile(join(repo, '.forest', 'descriptions.json'), '["nope"]');
    assert.deepEqual(await readDescriptions(repo), {});
  });
});

test('clearDescription: removes one key and leaves its siblings', async () => {
  await withRepo(async (repo) => {
    await saveDescription(repo, 'a', 'keep me');
    await saveDescription(repo, 'b', 'drop me');
    await clearDescription(repo, 'b');
    assert.deepEqual(await readDescriptions(repo), { a: 'keep me' });
    assert.equal(await readDescription(repo, 'b'), null);
  });
});

test('clearDescription: clearing an absent key is a no-op, not an error', async () => {
  await withRepo(async (repo) => {
    await clearDescription(repo, 'never-existed');
    assert.deepEqual(await readDescriptions(repo), {});
  });
});

test('concurrent saves on one repo do not lose writes', async () => {
  // The lock is the point: without it these read-modify-writes interleave and
  // all but the last key vanish.
  await withRepo(async (repo) => {
    const keys = Array.from({ length: 20 }, (_, i) => `branch-${i}`);
    await Promise.all(keys.map((k) => saveDescription(repo, k, `text ${k}`)));
    const all = await readDescriptions(repo);
    assert.equal(Object.keys(all).length, 20);
    for (const k of keys) assert.equal(all[k], `text ${k}`);
  });
});

test('concurrent save and clear on one repo stay consistent', async () => {
  await withRepo(async (repo) => {
    await saveDescription(repo, 'a', 'one');
    await Promise.all([
      saveDescription(repo, 'b', 'two'),
      clearDescription(repo, 'a'),
      saveDescription(repo, 'c', 'three'),
    ]);
    assert.deepEqual(await readDescriptions(repo), { b: 'two', c: 'three' });
  });
});

// ---- descriptionKey ----

test('descriptionKey: the branch, so the note survives remove + re-create', () => {
  assert.equal(descriptionKey({ branch: 'tech/WEBT-229553', path: '/wt/x' }), 'tech/WEBT-229553');
});

test('descriptionKey: a detached worktree falls back to its path', () => {
  assert.equal(descriptionKey({ branch: null, path: '/wt/detached' }), '/wt/detached');
});

// ---- resolveDescription ----

const CONFIG = {
  jiraBaseUrl: 'https://jira.sahibinden.com',
  jiraProjectKey: 'SHBDN',
  jiraToken: 'pat',
  jiraEmail: '',
};
const cacheOf = (result) => ({ calls: 0, async get() { this.calls++; return result; } });
const wt = (repo) => ({ repoPath: repo, branch: 'tech/WEBT-229553', path: '/wt/web-test/tech-WEBT-229553', ticket: 'WEBT-229553' });

test('resolveDescription: composes title + rewritten browse link', async () => {
  await withRepo(async (repo) => {
    const cache = cacheOf({ summary: 'CI - Ödeme Sayfası Kart ile Öde Componenti Dil Desteği - Arama' });
    const r = await resolveDescription({ worktree: wt(repo), config: CONFIG, cache });
    assert.equal(r.override, false);
    assert.equal(r.ticket, 'SHBDN-229553');
    assert.equal(r.url, 'https://jira.sahibinden.com/browse/SHBDN-229553');
    assert.equal(
      r.text,
      'CI - Ödeme Sayfası Kart ile Öde Componenti Dil Desteği - Arama\nhttps://jira.sahibinden.com/browse/SHBDN-229553',
    );
    assert.equal(r.jiraError, undefined);
  });
});

test('resolveDescription: an override wins and costs no Jira request', async () => {
  await withRepo(async (repo) => {
    await saveDescription(repo, 'tech/WEBT-229553', 'my own words');
    const cache = cacheOf({ summary: 'the ticket title' });
    const r = await resolveDescription({ worktree: wt(repo), config: CONFIG, cache });
    assert.equal(r.text, 'my own words');
    assert.equal(r.override, true);
    assert.equal(cache.calls, 0, 'an answered question must not hit the network');
    // The link is still resolved, so the drawer can show it alongside the override.
    assert.equal(r.url, 'https://jira.sahibinden.com/browse/SHBDN-229553');
  });
});

test('resolveDescription: a blank override is honoured, not re-filled from Jira', async () => {
  await withRepo(async (repo) => {
    await saveDescription(repo, 'tech/WEBT-229553', '');
    const cache = cacheOf({ summary: 'the ticket title' });
    const r = await resolveDescription({ worktree: wt(repo), config: CONFIG, cache });
    assert.equal(r.text, '');
    assert.equal(r.override, true);
    assert.equal(cache.calls, 0);
  });
});

test('resolveDescription: a Jira failure degrades to the link and reports why', async () => {
  await withRepo(async (repo) => {
    const cache = cacheOf({ error: 'Jira rejected the credentials (401)' });
    const r = await resolveDescription({ worktree: wt(repo), config: CONFIG, cache });
    assert.equal(r.text, 'https://jira.sahibinden.com/browse/SHBDN-229553');
    assert.equal(r.jiraError, 'Jira rejected the credentials (401)');
  });
});

test('resolveDescription: a branch with no ticket gets an empty, editable box', async () => {
  await withRepo(async (repo) => {
    const cache = cacheOf({ summary: null });
    const worktree = { repoPath: repo, branch: 'refactor-thing', path: '/wt/x', ticket: null };
    const r = await resolveDescription({ worktree, config: CONFIG, cache });
    assert.equal(r.text, '');
    assert.equal(r.ticket, null);
    assert.equal(r.url, null);
    assert.equal(r.jiraError, undefined, 'no ticket is not a failure');
  });
});

test('resolveDescription: with no project key the branch ticket is used as-is', async () => {
  await withRepo(async (repo) => {
    const cache = cacheOf({ summary: 'T' });
    const r = await resolveDescription({ worktree: wt(repo), config: { ...CONFIG, jiraProjectKey: '' }, cache });
    assert.equal(r.ticket, 'WEBT-229553');
    assert.equal(r.url, 'https://jira.sahibinden.com/browse/WEBT-229553');
  });
});
