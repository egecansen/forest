import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import fsp from 'node:fs/promises';
import url from 'node:url';
import { runStore } from './run-store.js';
import { startDriver, type DriverHandle } from './driver.js';
import { pendingAnswers } from './pending-answers.js';
import { normalizeRunBody } from './validate.js';
import { readProjectState } from './project-state.js';
import { listDirectories } from './browse.js';
import { isAllowedHost } from './host-guard.js';
import { getAuthStatus } from './auth-status.js';
import { startLogin, getLoginState, cancelLogin, logout } from './auth-login.js';
import { saveRun, listRuns, loadRun, isSafeRunId, resolveInsideRoot, resolveRunsDirSync } from './persistence.js';
import { findRecordings } from './recordings.js';
import type { RunSnapshot, ServerEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 8765);
const RUNS_DIR = resolveRunsDirSync();
const app = express();

// DNS-rebinding defense: reject any /api request whose Host header doesn't
// name this server's own loopback address, before any route handler runs.
// The static client (served below) is intentionally NOT guarded here.
app.use('/api', (req, res, next) => {
  if (!isAllowedHost(req.headers.host, PORT)) {
    res.status(403).json({ error: 'forbidden host' });
    return;
  }
  next();
});

app.use(express.json());

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');

// Active driver handles keyed by runId so the HTTP stop/pause/resume routes can
// control them. Each handle is callable (stop) with a `.pause` method.
const drivers = new Map<string, DriverHandle>();

// Statuses a run never leaves once reached (see Run.stop/finish — both are
// guarded by `this.stopped` and set exactly one of these).
const TERMINAL_RUN_STATUSES = new Set<RunSnapshot['status']>(['completed', 'failed', 'cancelled']);

/**
 * Project-total active time + tokens across every finished run for
 * `projectPath`, used to seed "previous session" on a continued/resumed run.
 * Sums each prior run's OWN contribution (`elapsedMs − priorElapsedMs`, likewise
 * tokens) so a run that already carried a base isn't double-counted — the total
 * is correct whether or not the seed chain is intact. Returns zeros if none.
 */
async function priorTotalsForProject(
  projectPath: string,
  excludeRunId: string
): Promise<{ elapsedMs: number; tokens: number; costUsd: number; phases: RunSnapshot['phases'] }> {
  const target = path.resolve(projectPath);
  const summaries = await listRuns(RUNS_DIR); // newest-first
  let elapsedMs = 0;
  let tokens = 0;
  let costUsd = 0;
  let phases: RunSnapshot['phases'] = [];
  for (const s of summaries) {
    if (s.runId === excludeRunId) continue;
    if (path.resolve(s.projectPath) !== target) continue;
    if (!TERMINAL_RUN_STATUSES.has(s.status)) continue;
    const snap = await loadRun(RUNS_DIR, s.runId);
    if (!snap) continue;
    const t = snap.telemetry ?? ({} as RunSnapshot['telemetry']);
    elapsedMs += Math.max(0, (t.elapsedMs ?? 0) - (t.priorElapsedMs ?? 0));
    tokens += Math.max(0, (t.tokens ?? 0) - (t.priorTokens ?? 0));
    // Real per-run API-rate cost contribution; runs recorded before cost
    // tracking simply contribute 0, so the prior-cost line is honest either way.
    costUsd += Math.max(0, (t.costUsd ?? 0) - (t.priorCostUsd ?? 0));
    // Per-phase durations come from the SINGLE most-recent prior run (it already
    // carries the chain's accumulated activeMs), not a sum across runs. (#14)
    if (phases.length === 0 && Array.isArray(snap.phases)) phases = snap.phases;
  }
  return { elapsedMs, tokens, costUsd, phases };
}

// Graceful shutdown: stop every running driver (which kills its child process
// group) before exiting, so SIGINT/SIGTERM don't orphan spawned child
// processes. Guarded + idempotent — safe if invoked more than once (e.g. a
// second signal arriving mid-shutdown) or if a driver's stop() throws.
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const stop of drivers.values()) {
    try {
      stop();
    } catch {
      // best-effort: a stuck driver shouldn't block the rest from stopping.
    }
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/project-state', async (req, res) => {
  const p = req.query.path;
  if (typeof p !== 'string' || !p.trim()) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  try {
    const state = await readProjectState(path.resolve(p.trim()));
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: `could not read project state: ${(err as Error).message}` });
  }
});

app.get('/api/auth-status', async (_req, res) => {
  res.json(await getAuthStatus());
});

app.post('/api/auth-login', (req, res) => {
  const method = req.body?.method === 'console' ? 'console' : 'subscription';
  res.json(startLogin(method));
});

app.get('/api/auth-login/state', (_req, res) => res.json(getLoginState()));

app.post('/api/auth-login/cancel', (_req, res) => {
  cancelLogin();
  res.json({ ok: true });
});

app.post('/api/auth-logout', async (_req, res) => res.json(await logout()));

app.get('/api/browse', async (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path : undefined;
  try {
    res.json(await listDirectories(p));
  } catch (err) {
    res.status(400).json({ error: `cannot read directory: ${(err as Error).message}` });
  }
});

app.post('/api/runs', async (req, res) => {
  const parsed = normalizeRunBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  // Continue requires an existing project dir; New may create it (driver mkdir -p's).
  // Demo runs are exempt — the simulator never touches the filesystem, and the
  // demo project path is synthetic, so a real-directory check would wrongly reject
  // "continue this run" on a demo run.
  if (parsed.value.projectMode === 'continue' && !parsed.value.demo) {
    try {
      const stat = await fsp.stat(parsed.value.projectPath);
      if (!stat.isDirectory()) throw new Error('not a directory');
    } catch {
      res.status(400).json({ error: `project path does not exist: ${parsed.value.projectPath}` });
      return;
    }
  }
  const run = runStore.create(parsed.value, parsed.secret);
  const runId = run.snapshot.config!.runId;
  // Seed "previous session" time from the most-recent finished run of the same
  // project, so a continued/resumed run shows prior + total from the first
  // render (the chain accumulates because each run's elapsedMs carries its own
  // base). Best-effort — a lookup failure just means no prior line.
  try {
    // Only a project that still carries a pipeline ledger is a continuation of
    // prior work. A wiped/fresh project starts from zero — inheriting archive
    // totals there labels dead history as "previous sessions" on a run that
    // has none (F18). The archive itself is untouched; only the seed is gated.
    await fsp.access(
      path.join(parsed.value.projectPath, 'tests', 'e2e', 'docs', 'onboarding-status.json')
    );
    const prior = await priorTotalsForProject(parsed.value.projectPath, runId);
    if (prior.elapsedMs > 0 || prior.tokens > 0 || prior.costUsd > 0)
      run.seedPrior(prior.elapsedMs, prior.tokens, prior.costUsd);
    if (prior.phases.length > 0) run.seedPriorPhases(prior.phases);
  } catch {
    /* fresh project (no ledger) or lookup failure — no prior line */
  }
  const stop = startDriver(run);
  drivers.set(runId, stop);

  // The drivers map is otherwise only pruned by the explicit /stop route —
  // a run that completes or fails on its own would sit there forever.
  // Watch for the run's one-and-only terminal status event and drop the
  // stop handle shortly after, giving any open WS a grace period to
  // deliver the final snapshot before /stop starts 404ing for this run.
  const onEvent = (ev: ServerEvent) => {
    if (ev.type === 'status' && TERMINAL_RUN_STATUSES.has(ev.status)) {
      run.off('event', onEvent);
      // Persist the final snapshot so this run survives a server restart and
      // shows up in run history. Safe: `run.snapshot` never carries the
      // secret (see Run.secret in run-store.ts). Fire-and-forget — a write
      // failure (e.g. unwritable home dir) shouldn't affect the live run.
      void saveRun(RUNS_DIR, run.snapshot);
      setTimeout(() => {
        drivers.delete(runId);
      }, 30_000);
    }
  };
  run.on('event', onEvent);

  res.json({ runId });
});

app.post('/api/runs/:runId/stop', (req, res) => {
  const id = req.params.runId;
  const stop = drivers.get(id);
  if (!stop) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  stop();
  drivers.delete(id);
  res.json({ ok: true });
});

// Suspend a live run into a resumable `paused` state. Only a `running` run can
// pause (an awaiting-input run must be answered or stopped first). The handle
// stays in `drivers` so /resume or /stop can still act on it. (finding F6)
app.post('/api/runs/:runId/pause', (req, res) => {
  const id = req.params.runId;
  const handle = drivers.get(id);
  const run = runStore.get(id);
  if (!handle || !run) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  if (run.snapshot.status !== 'running') {
    res.status(409).json({ error: `cannot pause a run in status "${run.snapshot.status}"` });
    return;
  }
  handle.pause();
  res.json({ ok: true });
});

// Resume a paused run — re-enter the SAME session from its recorded state via a
// fresh driver, replacing the handle. (finding F6)
app.post('/api/runs/:runId/resume', (req, res) => {
  const id = req.params.runId;
  const run = runStore.get(id);
  if (!run) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  if (run.snapshot.status !== 'paused') {
    res.status(409).json({ error: `cannot resume a run in status "${run.snapshot.status}"` });
    return;
  }
  drivers.set(id, startDriver(run, undefined, { resume: true }));
  res.json({ ok: true });
});

// Resolves an in-flight AskUserQuestion pause (see makeCanUseTool in
// driver.ts): the operator's chosen answer(s) are handed to the waiting
// `canUseTool` promise via the `pendingAnswers` registry. 409 when there is
// no pending question matching runId+questionId (already answered, stale
// questionId, or the run never asked). `answers` is operator-authored option
// labels, never logged raw here.
app.post('/api/runs/:runId/answer', (req, res) => {
  const { questionId, answers } = (req.body ?? {}) as { questionId?: string; answers?: Record<string, unknown> };
  if (typeof questionId !== 'string' || answers == null || typeof answers !== 'object') {
    res.status(400).json({ error: 'questionId and answers are required' });
    return;
  }
  const ok = pendingAnswers.resolve(req.params.runId, questionId, answers);
  if (!ok) {
    res.status(409).json({ error: 'no matching pending question' });
    return;
  }
  res.json({ ok: true });
});

// Active (non-terminal) runs — lets the client reconnect to a live run after a
// reload / back-button / HMR instead of dropping to the start screen.
app.get('/api/runs', (_req, res) => {
  res.json(runStore.listActive());
});

app.get('/api/runs/:runId', (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  res.json(run.snapshot);
});

// Serve a completed run's report deck from the run's project root.
app.get('/api/runs/:runId/report', (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run?.snapshot.config) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  const deck = path.resolve(run.snapshot.config.projectPath, 'qa-summary-deck.html');
  // Sandbox: the file must live directly in the run's project root.
  if (path.dirname(deck) !== path.resolve(run.snapshot.config.projectPath)) {
    res.status(400).json({ error: 'invalid report path' });
    return;
  }
  res.sendFile(deck, (err) => {
    if (err) res.status(404).json({ error: 'report not found' });
  });
});

// Resolve a run's project root from the LIVE run first, else the persisted
// history snapshot — so recordings work both during a run and shortly after it
// finishes (once the driver map has dropped the live Run). Returns null when
// neither source knows the run. `loadRun` already guards `isSafeRunId`
// structurally, and the callers below guard it at the route layer too.
async function projectPathForRun(runId: string): Promise<string | null> {
  const run = runStore.get(runId);
  if (run?.snapshot.config) return run.snapshot.config.projectPath;
  const snap = await loadRun(RUNS_DIR, runId);
  return snap?.config?.projectPath ?? null;
}

// List every video/trace/screenshot artifact discovered under the run's
// project. `findRecordings` is total (missing project/dirs → []).
app.get('/api/runs/:runId/recordings', async (req, res) => {
  if (!isSafeRunId(req.params.runId)) {
    res.status(400).json({ error: 'invalid run id' });
    return;
  }
  const projectPath = await projectPathForRun(req.params.runId);
  if (!projectPath) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  res.json(await findRecordings(projectPath));
});

// Serve one recording file by its project-relative `path` query. This is a
// path-traversal-sensitive surface, so it is guarded three ways: (1) the runId
// must be a bare safe token; (2) the resolved file must stay inside the run's
// project root (mirrors the /report route sandbox); (3) only .webm/.zip/.png
// extensions are served. A crafted `path` (e.g. `../../etc/passwd`,
// `..%2f..`) resolves OUTSIDE resolvedRoot and is rejected by the startsWith
// check before sendFile ever sees it.
app.get('/api/runs/:runId/recording', async (req, res) => {
  if (!isSafeRunId(req.params.runId)) {
    res.status(400).json({ error: 'invalid run id' });
    return;
  }
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  const projectPath = await projectPathForRun(req.params.runId);
  if (!projectPath || !rel) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const resolvedRoot = path.resolve(projectPath);
  const file = path.resolve(resolvedRoot, rel);
  // Sandbox: the resolved file must be the root itself or live beneath it.
  if (!(file === resolvedRoot || file.startsWith(resolvedRoot + path.sep))) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  // Only known media extensions may ever be served from the project tree.
  if (!/\.(webm|zip|png)$/i.test(file)) {
    res.status(400).json({ error: 'unsupported file' });
    return;
  }
  res.sendFile(file, (err) => {
    if (err) res.status(404).json({ error: 'not found' });
  });
});

// Serve one project file's TEXT content for the Files-tab viewer. Path-traversal
// sensitive, guarded exactly like /recording: (1) the runId must be a bare safe
// token; (2) the resolved file must stay inside the run's project root. Caps the
// payload and refuses binary so the client never has to render a blob. (F5)
const FILE_VIEW_CAP = 512 * 1024; // 512 KB
app.get('/api/runs/:runId/file', async (req, res) => {
  if (!isSafeRunId(req.params.runId)) {
    res.status(400).json({ error: 'invalid run id' });
    return;
  }
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  const projectPath = await projectPathForRun(req.params.runId);
  if (!projectPath || !rel) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Sandbox: the resolved file must live inside the run's project root.
  const file = resolveInsideRoot(projectPath, rel);
  if (!file) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const buf = await fsp.readFile(file);
    const slice = buf.subarray(0, FILE_VIEW_CAP);
    // Binary sniff: a NUL byte in the served slice ⇒ don't try to render text.
    if (slice.includes(0)) {
      res.json({ path: rel, binary: true, bytes: stat.size });
      return;
    }
    res.json({
      path: rel,
      content: slice.toString('utf8'),
      bytes: stat.size,
      truncated: stat.size > slice.length,
    });
  } catch {
    res.status(404).json({ error: 'not found' });
  }
});

// Flat-file run history: past runs persisted to RUNS_DIR on terminal status
// (see the onEvent subscription in POST /api/runs above), so they survive a
// server restart and can be reopened read-only from the start screen.
app.get('/api/history', async (_req, res) => {
  res.json(await listRuns(RUNS_DIR));
});

app.get('/api/history/:runId', async (req, res) => {
  // Sandbox: reject anything but a bare token before it reaches the
  // filesystem — real run ids are randomUUID() values. Blocks path
  // traversal (e.g. `..%2F..%2F..%2Fsomething`) at the route layer;
  // loadRun's resolve-inside-dir check backs this up structurally.
  if (!isSafeRunId(req.params.runId)) {
    res.status(400).json({ error: 'invalid run id' });
    return;
  }
  const snapshot = await loadRun(RUNS_DIR, req.params.runId);
  if (!snapshot) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  res.json(snapshot);
});

// Serve built client when present (production mode).
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  // DNS-rebinding defense: mirror the /api Host check on the sibling /ws
  // channel — without this, a rebound-DNS Host header could open the
  // upgrade and exfiltrate live run telemetry/logs/findings over the WS.
  if (!isAllowedHost(request.headers.host, PORT)) {
    socket.destroy();
    return;
  }
  const u = new URL(request.url ?? '/', 'http://localhost');
  if (u.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const runId = u.searchParams.get('runId');
  if (!runId) {
    socket.destroy();
    return;
  }
  const run = runStore.get(runId);
  if (!run) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    // Push snapshot first so the client renders the up-to-date state.
    const initial: ServerEvent = { type: 'snapshot', snapshot: run.snapshot };
    ws.send(JSON.stringify(initial));
    const listener = (ev: ServerEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
    };
    run.on('event', listener);
    ws.on('close', () => run.off('event', listener));
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[hektor-console] listening on http://localhost:${PORT}`);
});
