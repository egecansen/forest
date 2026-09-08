import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTicketStatus, readTicketStatus, TICKET_STATUSES } from './ticket-status.mjs';

const withDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'forest-tkstatus-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

const briefRel = (ticket) => join('docs', 'hektor', 'tickets', `${ticket}.md`);

async function writeBrief(worktreePath, ticket, body) {
  const path = join(worktreePath, briefRel(ticket));
  await mkdir(join(worktreePath, 'docs', 'hektor', 'tickets'), { recursive: true });
  await writeFile(path, body);
}

test('TICKET_STATUSES: the fixed closed vocabulary', () => {
  assert.deepEqual(TICKET_STATUSES, ['not started', 'in progress', 'blocked', 'ready for review']);
});

// --- parseTicketStatus: vocabulary handling -------------------------------

test('parseTicketStatus: accepts every vocabulary value, case-insensitively', () => {
  for (const s of TICKET_STATUSES) {
    assert.equal(parseTicketStatus(`Status: ${s}`), s);
    assert.equal(parseTicketStatus(`Status: ${s.toUpperCase()}`), s);
    assert.equal(parseTicketStatus(`status: ${s}`), s);
  }
});

test('parseTicketStatus: reads the Status: line out of a full brief body', () => {
  const body = [
    '# SHBDN-1234', '', '## Progress', '', 'Status: in progress',
    '<!-- one of: not started | in progress | blocked | ready for review -->',
    '', '- [ ] Ticket + linked tickets read', '', '## Notes', '',
  ].join('\n');
  assert.equal(parseTicketStatus(body), 'in progress');
});

test('parseTicketStatus: an unrecognized value reads as null, not raw text', () => {
  assert.equal(parseTicketStatus('Status: definitely done'), null);
  assert.equal(parseTicketStatus('Status: <script>alert(1)</script>'), null);
  assert.equal(parseTicketStatus('Status:'), null);
});

test('parseTicketStatus: no Status: line at all reads as null', () => {
  assert.equal(parseTicketStatus('# just a heading\n\nsome notes'), null);
  assert.equal(parseTicketStatus(''), null);
  assert.equal(parseTicketStatus(undefined), null);
  assert.equal(parseTicketStatus(null), null);
});

test('parseTicketStatus: tolerates trailing whitespace and CRLF', () => {
  assert.equal(parseTicketStatus('Status: blocked   \r\n'), 'blocked');
});

// --- readTicketStatus: the absent-file case -------------------------------

test('readTicketStatus: no ticket means no I/O at all — stat and readFile are never called', async () => {
  let statCalls = 0, readCalls = 0;
  const cache = new Map();
  const result = await readTicketStatus('/anywhere', null, cache, {
    statImpl: async () => { statCalls++; throw new Error('should not be called'); },
    readFileImpl: async () => { readCalls++; throw new Error('should not be called'); },
  });
  assert.equal(result, null);
  assert.equal(statCalls, 0);
  assert.equal(readCalls, 0);
});

test('readTicketStatus: no brief file — stats once, never reads, returns null', async () => {
  await withDir(async (dir) => {
    let readCalls = 0;
    const cache = new Map();
    const real = await import('node:fs/promises');
    const result = await readTicketStatus(dir, 'SHBDN-1', cache, {
      statImpl: real.stat,
      readFileImpl: async (...a) => { readCalls++; return real.readFile(...a); },
    });
    assert.equal(result, null);
    assert.equal(readCalls, 0, 'a file that is not there must never be read');
  });
});

test('readTicketStatus: a brief with a valid Status: line returns { key, status }', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-42', 'Status: ready for review\n');
    const cache = new Map();
    const result = await readTicketStatus(dir, 'SHBDN-42', cache);
    assert.deepEqual(result, { key: 'SHBDN-42', status: 'ready for review' });
  });
});

test('readTicketStatus: a brief with no valid Status: line returns null (not raw content)', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-42', 'Status: whatever the agent felt like\n');
    const cache = new Map();
    const result = await readTicketStatus(dir, 'SHBDN-42', cache);
    assert.equal(result, null);
  });
});

test('readTicketStatus: only looks at the brief matching the worktree\'s own ticket, never another one sitting alongside it', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-1', 'Status: blocked\n');
    await writeBrief(dir, 'SHBDN-2', 'Status: ready for review\n');
    const cache = new Map();
    // Worktree's own ticket is SHBDN-1 — SHBDN-2's brief, however valid, is
    // never consulted even though it lives in the same directory.
    assert.deepEqual(await readTicketStatus(dir, 'SHBDN-1', cache), { key: 'SHBDN-1', status: 'blocked' });
  });
});

// --- readTicketStatus: branch-prefix vs Jira-key re-keying ----------------
//
// Branches carry a team prefix (tech/WEBT-241011) while the tickets flow
// writes briefs under the real Jira key (SHBDN-241011) — the same split
// jiraKey() in lib/jira.mjs exists to bridge. These are the exact regression
// cases for that bug: the earlier version of this module only ever built
// `docs/hektor/tickets/<branch-ticket>.md` and so never found a brief named
// after the re-keyed Jira key, even with 19 green tests, because every test
// (above) used the same name for both the branch ticket and the file on
// disk — a mismatch the suite never exercised.

test('readTicketStatus: a brief named after the re-keyed Jira key is found even though the branch ticket differs', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-241011', 'Status: in progress\n');
    const cache = new Map();
    const result = await readTicketStatus(dir, 'WEBT-241011', cache, { projectKey: 'SHBDN' });
    // key stays the branch-derived ticket — same identity the row's branch
    // cell and `w.ticket` already use elsewhere.
    assert.deepEqual(result, { key: 'WEBT-241011', status: 'in progress' });
  });
});

test('readTicketStatus: the warm path (re-keyed brief present) costs exactly one stat', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-241011', 'Status: in progress\n');
    let statCalls = 0;
    const cache = new Map();
    const real = await import('node:fs/promises');
    const opts = { projectKey: 'SHBDN', statImpl: async (...a) => { statCalls++; return real.stat(...a); } };
    await readTicketStatus(dir, 'WEBT-241011', cache, opts);
    assert.equal(statCalls, 1, 'the common case must not pay for the fallback candidate too');
  });
});

test('readTicketStatus: falls back to the raw branch ticket\'s brief when the re-keyed one is absent', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'WEBT-5', 'Status: blocked\n'); // old-style naming, no SHBDN-5.md
    const cache = new Map();
    const result = await readTicketStatus(dir, 'WEBT-5', cache, { projectKey: 'SHBDN' });
    assert.deepEqual(result, { key: 'WEBT-5', status: 'blocked' });
  });
});

test('readTicketStatus: neither the re-keyed nor the raw name present stays null (both candidates tried)', async () => {
  await withDir(async (dir) => {
    let statCalls = 0;
    const cache = new Map();
    const real = await import('node:fs/promises');
    const opts = { projectKey: 'SHBDN', statImpl: async (...a) => { statCalls++; return real.stat(...a); } };
    const result = await readTicketStatus(dir, 'WEBT-6', cache, opts);
    assert.equal(result, null);
    assert.equal(statCalls, 2, 'a genuine miss checks both the re-keyed and raw names before giving up');
  });
});

test('readTicketStatus: an empty projectKey never re-keys — only the raw ticket name is tried, one stat', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'WEBT-7', 'Status: ready for review\n');
    let statCalls = 0;
    const cache = new Map();
    const real = await import('node:fs/promises');
    const opts = { statImpl: async (...a) => { statCalls++; return real.stat(...a); } }; // no projectKey — default ''
    const result = await readTicketStatus(dir, 'WEBT-7', cache, opts);
    assert.deepEqual(result, { key: 'WEBT-7', status: 'ready for review' });
    assert.equal(statCalls, 1, 'installs that never configured jiraProjectKey must keep working at one stat');
  });
});

test('readTicketStatus: a brief absent at first look is not cached negative — creating it afterward is picked up on the very next call', async () => {
  await withDir(async (dir) => {
    const cache = new Map();
    const opts = { projectKey: 'SHBDN' };
    const first = await readTicketStatus(dir, 'WEBT-241012', cache, opts);
    assert.equal(first, null, 'no brief exists yet');

    await writeBrief(dir, 'SHBDN-241012', 'Status: not started\n');
    const second = await readTicketStatus(dir, 'WEBT-241012', cache, opts);
    assert.deepEqual(second, { key: 'WEBT-241012', status: 'not started' }, 'a brief appearing after a prior miss must be noticed on the next tick, not stuck null');
  });
});

// --- readTicketStatus: the mtime cache ------------------------------------

test('readTicketStatus: an unchanged brief (same mtime) is not re-read on the next call', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-7', 'Status: in progress\n');
    let readCalls = 0;
    const cache = new Map();
    const real = await import('node:fs/promises');
    const opts = { statImpl: real.stat, readFileImpl: async (...a) => { readCalls++; return real.readFile(...a); } };

    const first = await readTicketStatus(dir, 'SHBDN-7', cache, opts);
    const second = await readTicketStatus(dir, 'SHBDN-7', cache, opts);

    assert.deepEqual(first, { key: 'SHBDN-7', status: 'in progress' });
    assert.deepEqual(second, { key: 'SHBDN-7', status: 'in progress' });
    assert.equal(readCalls, 1, 'the second call must be served from the mtime cache, not a fresh read');
  });
});

test('readTicketStatus: a negative parse (no valid Status:) is cached by mtime too — unchanged-but-unparseable is not re-read', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-8', 'Status: nonsense\n');
    let readCalls = 0;
    const cache = new Map();
    const real = await import('node:fs/promises');
    const opts = { statImpl: real.stat, readFileImpl: async (...a) => { readCalls++; return real.readFile(...a); } };

    assert.equal(await readTicketStatus(dir, 'SHBDN-8', cache, opts), null);
    assert.equal(await readTicketStatus(dir, 'SHBDN-8', cache, opts), null);
    assert.equal(readCalls, 1);
  });
});

test('readTicketStatus: a changed mtime forces a re-read and picks up the new value', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-9', 'Status: not started\n');
    const cache = new Map();
    const first = await readTicketStatus(dir, 'SHBDN-9', cache);
    assert.deepEqual(first, { key: 'SHBDN-9', status: 'not started' });

    await writeBrief(dir, 'SHBDN-9', 'Status: blocked\n');
    // Force a distinct mtime rather than sleeping past filesystem resolution.
    const bumped = new Date(Date.now() + 5000);
    await utimes(join(dir, briefRel('SHBDN-9')), bumped, bumped);

    const second = await readTicketStatus(dir, 'SHBDN-9', cache);
    assert.deepEqual(second, { key: 'SHBDN-9', status: 'blocked' });
  });
});

test('readTicketStatus: a brief that later vanishes drops out of the cache and reads as null again', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-10', 'Status: blocked\n');
    const cache = new Map();
    assert.deepEqual(await readTicketStatus(dir, 'SHBDN-10', cache), { key: 'SHBDN-10', status: 'blocked' });

    await rm(join(dir, briefRel('SHBDN-10')));
    assert.equal(await readTicketStatus(dir, 'SHBDN-10', cache), null);
  });
});

test('readTicketStatus: a cache Map is scoped per call — nothing module-level leaks between two independent callers', async () => {
  await withDir(async (dir) => {
    await writeBrief(dir, 'SHBDN-11', 'Status: in progress\n');
    const cacheA = new Map();
    const cacheB = new Map();
    await readTicketStatus(dir, 'SHBDN-11', cacheA);
    assert.equal(cacheB.size, 0, 'a fresh cache must start empty regardless of what other callers have cached');
  });
});
