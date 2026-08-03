import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, publicConfig } from './lib/config.mjs';
import { buildSnapshot } from './lib/discover.mjs';
import { createRegistry } from './lib/agents.mjs';
import { createJournal } from './lib/journal.mjs';
import { runGit } from './lib/git.mjs';
import { listPacks } from './lib/packs.mjs';
import { createActionHandler } from './lib/actions.mjs';
import { pruneLandings } from './lib/landed.mjs';
import { readRepoState } from './lib/repos.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CLAUDE_PROJECTS = `${process.env.HOME}/.claude/projects`;

const config = await loadConfig(join(ROOT, 'config.json'));
const clientConfig = publicConfig(config);
const registry = createRegistry();
const journal = createJournal({ max: 300 });
const sizes = new Map();

// Spec §1: "Malformed file → empty list plus one warning in the journal."
// readRepoList alone can't tell "absent" from "unreadable" (both come back
// []), so read the full state here and journal once when it's the latter.
const { repos: initialRepoList, malformed: repoListMalformed } = await readRepoState(ROOT);
let repoList = initialRepoList;
if (repoListMalformed) {
  journal.add({ cmd: 'repos.json is malformed and was ignored (nothing was overwritten) — listed repos are unavailable until it is fixed', cwd: ROOT, mode: 'auto' });
}
const warnedRepos = new Set();

const clients = new Set(); // SSE response objects

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
journal.subscribe((entry) => broadcast('journal', entry));

// The last snapshot built, kept so read-only callers do not have to pay for a
// fresh one. A full build walks every worktree in every repo and takes seconds;
// the periodic loop below is already paying that cost on a timer.
let lastSnapshot = null;

async function snapshot() {
  const snap = await buildSnapshot(config, { registry, nowMs: Date.now(), claudeProjectsDir: CLAUDE_PROJECTS, sizes, repoList });
  for (const p of snap.skippedRepos) {
    if (warnedRepos.has(p)) continue;
    warnedRepos.add(p);
    journal.add({ cmd: `repo skipped: ${p} is no longer a git repository (still listed)`, cwd: ROOT, mode: 'auto' });
  }
  lastSnapshot = snap;
  return snap;
}

// For callers that only display: at most one refresh interval stale, which the
// UI already is between broadcasts. Never use this to decide a mutation — the
// prune executor re-reads a fresh snapshot for exactly that reason.
async function cachedSnapshot() {
  return lastSnapshot ?? snapshot();
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

async function serveStatic(req, res) {
  let rel = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const path = normalize(join(PUBLIC, rel));
  if (path !== PUBLIC && !path.startsWith(PUBLIC + '/')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

// Shared context handed to the action router (Task 8).
export const ctx = {
  config, registry, journal, broadcast, snapshot, cachedSnapshot, CLAUDE_PROJECTS,
  forestRoot: ROOT,
  getRepoList: () => repoList,
  setRepoList: (list) => { repoList = list; warnedRepos.clear(); },
};

// Action router is attached in Task 8; defaults to 404 until then.
export let handleAction = async (req, res) => { res.writeHead(404).end('no action'); };
export function setActionHandler(fn) { handleAction = fn; }
setActionHandler(createActionHandler());

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url === '/api/config') return sendJson(res, clientConfig);
  if (url === '/api/worktrees') return sendJson(res, await snapshot());
  if (url === '/api/journal') return sendJson(res, journal.recent());
  if (url === '/api/packs') return sendJson(res, { packs: await listPacks(config.packsDir) });
  if (url === '/api/diff') {
    const p = new URL(req.url, 'http://x').searchParams.get('path');
    if (!p) return sendJson(res, { diff: '', error: 'path required' }, 400);
    // `diff HEAD` shows staged + unstaged together (what changed since the last
    // commit), matching how GitHub Desktop presents a worktree's changes.
    try { return sendJson(res, { diff: await runGit(p, ['diff', 'HEAD']) }); }
    catch (e) { return sendJson(res, { diff: '', error: String(e) }); }
  }
  if (url.startsWith('/api/')) return handleAction(req, res, ctx, readBody);

  return serveStatic(req, res);
});

// Periodic snapshot push.
const snapshotInterval = setInterval(async () => { try { broadcast('worktrees', await snapshot()); } catch { /* ignore */ } }, 4000);
server.on('close', () => clearInterval(snapshotInterval));

// Startup prune: expired landing-ledger entries + their safety refs, once per repo.
snapshot().then((snap) => { for (const r of snap.repos) pruneLandings(r.repoPath).catch(() => {}); }).catch(() => {});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Forest on http://127.0.0.1:${config.port}`);
});
