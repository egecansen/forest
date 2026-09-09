import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, publicConfig } from './lib/config.mjs';
import { buildSnapshot } from './lib/discover.mjs';
import { createRegistry } from './lib/agents.mjs';
import { createJournal } from './lib/journal.mjs';
import { runGit } from './lib/git.mjs';
import { listPacks, autoSelections, packTargets } from './lib/packs.mjs';
import { gateRequest } from './lib/request-gate.mjs';
import { createActionHandler, originOf } from './lib/actions.mjs';
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
// Server-lifetime cache for ticket-status parses, keyed by brief path and
// refreshed on mtime change (see lib/ticket-status.mjs). Unlike `sizes` this
// one IS filled on the periodic loop below — stat+mtime-cached readFile is
// cheap enough (no subprocess) to sit on the 4s snapshot tick.
const ticketStatusCache = new Map();

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
  const snap = await buildSnapshot(config, {
    registry, nowMs: Date.now(), claudeProjectsDir: CLAUDE_PROJECTS, sizes, ticketStatusCache, repoList,
  });
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
    // no-cache (revalidate, not no-store): without any cache header the
    // browser heuristically caches app.js, and a UI fix ships only to users
    // who think to hard-reload — observed as "the popup keeps coming back"
    // while the fixed file sat on disk.
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream', 'cache-control': 'no-cache' });
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

// One journal line per distinct (origin, host) that was refused, so an
// actual attempt is visible without a flood. Capped: an attacker must not be
// able to grow this without bound.
const refused = new Set();
const server = http.createServer(async (req, res) => {
  const gate = gateRequest(req, { port: config.port, srpOrigin: originOf(config.srpBaseUrl) });
  if (!gate.ok) {
    const key = `${req.headers.origin || '-'}|${req.headers.host || '-'}`;
    if (!refused.has(key) && refused.size < 100) {
      refused.add(key);
      journal.add({ cmd: `refused request from ${req.headers.origin || '(no origin)'} (host ${req.headers.host || '(none)'}): ${gate.reason}`, cwd: ROOT, mode: 'auto' });
    }
    res.writeHead(gate.status).end();
    return;
  }
  const url = req.url.split('?')[0];

  // Private Network Access preflight for the SRP bookmarklet's POST. The
  // request gate above has already required the configured SRP origin for
  // this path; these headers only let a legitimate SRP tab's fetch() succeed.
  if (url === '/api/srp/token' && req.method === 'OPTIONS') {
    const expectedOrigin = originOf(config.srpBaseUrl);
    const reqOrigin = req.headers.origin || '';
    if (expectedOrigin && reqOrigin === expectedOrigin) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': expectedOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    res.writeHead(403).end();
    return;
  }

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
  if (url === '/api/packs') {
    const repo = new URL(req.url, 'http://x').searchParams.get('repo');
    const packs = await listPacks(config.packsDir);
    return sendJson(res, { packs, auto: repo ? autoSelections(packs, repo) : [] });
  }
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

// A catalog whose `targets` is not an array of strings is picker-only; say so
// once at startup rather than silently never auto-provisioning.
listPacks(config.packsDir).then((packs) => {
  for (const p of packs) {
    if (p.targets !== undefined && !Array.isArray(p.targets)) {
      journal.add({ cmd: `pack ${p.pack}: catalog "targets" is not an array — the pack will not auto-provision until it is`, cwd: ROOT, mode: 'auto' });
    } else if (Array.isArray(p.targets) && packTargets(p).length !== p.targets.length) {
      journal.add({ cmd: `pack ${p.pack}: some catalog "targets" entries are not non-empty strings and were ignored`, cwd: ROOT, mode: 'auto' });
    }
  }
}).catch(() => {});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Forest on http://127.0.0.1:${config.port}`);
});
