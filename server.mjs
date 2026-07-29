import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { buildSnapshot } from './lib/discover.mjs';
import { createRegistry } from './lib/agents.mjs';
import { createJournal } from './lib/journal.mjs';
import { runGit } from './lib/git.mjs';
import { listPacks } from './lib/packs.mjs';
import { createActionHandler } from './lib/actions.mjs';
import { pruneLandings } from './lib/landed.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const CLAUDE_PROJECTS = `${process.env.HOME}/.claude/projects`;

const config = await loadConfig(join(ROOT, 'config.json'));
const registry = createRegistry();
const journal = createJournal({ max: 300 });
const sizes = new Map();

const clients = new Set(); // SSE response objects

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
journal.subscribe((entry) => broadcast('journal', entry));

async function snapshot() {
  return buildSnapshot(config, { registry, nowMs: Date.now(), claudeProjectsDir: CLAUDE_PROJECTS, sizes });
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
export const ctx = { config, registry, journal, broadcast, snapshot, CLAUDE_PROJECTS };

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
  if (url === '/api/config') return sendJson(res, config);
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
