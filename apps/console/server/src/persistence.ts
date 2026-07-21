import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunSnapshot, RunSummary } from './types.js';

export const DEFAULT_ROOT = process.env.HEKTOR_CONSOLE_HOME ?? path.join(os.homedir(), '.hektor-console');
/**
 * Default flat-file store for completed run snapshots. Created lazily on
 * first write — `listRuns`/`loadRun` never require it to exist.
 */
export const DEFAULT_RUNS_DIR = path.join(DEFAULT_ROOT, 'runs');

export function resolveRunsDirSync(newRoot: string = DEFAULT_ROOT): string {
  return path.join(newRoot, 'runs');
}

/**
 * On-disk run-history cap, mirroring the in-memory Run-store's MAX_RUNS
 * bound. Without this, the runs dir (and therefore `GET /api/history`,
 * which lists every file in it) grows without bound for the lifetime of
 * the installation.
 */
export const MAX_PERSISTED_RUNS = 50;

const runFile = (dir: string, runId: string): string => path.join(dir, `${runId}.json`);

/**
 * True iff `id` is a bare, path-safe token (letters, digits, `_`, `-` only —
 * no `/`, `\`, `.`, or whitespace). Real run ids are `randomUUID()` values,
 * which always satisfy this. Exported so route handlers can reject an
 * untrusted `:runId` param before it ever reaches persistence.
 */
export function isSafeRunId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Resolve a caller-supplied RELATIVE path against `root` and assert the result
 * stays within `root` (the root itself or a descendant). Returns the resolved
 * absolute path, or null when `rel` is empty, absolute, or escapes via `..`.
 * The structural half of the Files-tab file viewer's path-traversal defense —
 * unlike `resolveInsideDir` it permits subdirectories. (finding F5)
 */
export function resolveInsideRoot(root: string, rel: string): string | null {
  if (!rel) return null;
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, rel);
  if (file !== resolvedRoot && !file.startsWith(resolvedRoot + path.sep)) return null;
  return file;
}

/**
 * Resolves `<dir>/<runId>.json` and asserts the result still lives directly
 * inside `dir` — i.e. `runId` didn't smuggle in a `..`/`/` path segment that
 * `path.join` would otherwise happily traverse out with. Returns the
 * resolved absolute path, or `null` if it would escape `dir`.
 *
 * This is the structural (persistence-layer) half of the path-traversal
 * defense — it holds even if a caller forgets the `isSafeRunId` route guard.
 * Mirrors the sandbox check in `GET /api/runs/:runId/report` (index.ts).
 */
function resolveInsideDir(dir: string, runId: string): string | null {
  const resolved = path.resolve(runFile(dir, runId));
  if (path.dirname(resolved) !== path.resolve(dir)) return null;
  return resolved;
}

/**
 * Persists a run's snapshot as `<dir>/<runId>.json`. `snapshot` contains no
 * secret by construction (see `Run.secret` in run-store.ts), so writing it
 * straight to disk is safe.
 *
 * Atomic: writes to a temp file in the same directory first, then renames
 * it over the target. A reader (`loadRun`/`listRuns`) can therefore never
 * observe a partially-written file — `rename` is a single filesystem
 * operation, so the target either has the old contents or the new ones.
 */
export async function saveRun(dir: string, snapshot: RunSnapshot): Promise<void> {
  const runId = snapshot.config?.runId;
  if (!runId) return; // nothing to key the file by — nothing to save.
  const target = resolveInsideDir(dir, runId);
  if (!target) return; // runId would escape dir — refuse to write outside it.
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${runId.replace(/[/\\]/g, '_')}.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.rename(tmp, target);
  await pruneRuns(dir, MAX_PERSISTED_RUNS);
}

/**
 * Best-effort recency signal for a persisted run file: the snapshot's
 * `telemetry.startedAt` when the file parses cleanly (matching the
 * newest-first ordering `listRuns` already uses), falling back to mtime
 * for a corrupt/partial/legacy file that can't be parsed.
 */
async function fileRecency(dir: string, name: string): Promise<number> {
  const full = path.join(dir, name);
  try {
    const raw = await fs.readFile(full, 'utf8');
    const snapshot = JSON.parse(raw) as RunSnapshot;
    const startedAt = snapshot?.telemetry?.startedAt;
    if (typeof startedAt === 'number') return startedAt;
  } catch {
    // Not parseable — fall through to mtime below.
  }
  try {
    const stat = await fs.stat(full);
    return stat.mtimeMs;
  } catch {
    return -Infinity; // unstattable — prune it first.
  }
}

/**
 * Deletes all but the newest `maxRuns` `*.json` files in `dir`, keyed by
 * `fileRecency` (newest first). Tolerant end-to-end: a missing dir, an
 * unreadable/unstattable file, or a failed unlink is swallowed rather than
 * thrown — pruning is a housekeeping side effect of `saveRun` and must
 * never fail the save that triggered it.
 */
async function pruneRuns(dir: string, maxRuns: number): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const jsonFiles = entries.filter((name) => name.endsWith('.json') && !name.startsWith('.'));
    if (jsonFiles.length <= maxRuns) return;

    const withRecency = await Promise.all(
      jsonFiles.map(async (name) => ({ name, recency: await fileRecency(dir, name) }))
    );
    withRecency.sort((a, b) => b.recency - a.recency); // newest first

    const toDelete = withRecency.slice(maxRuns);
    await Promise.all(
      toDelete.map(({ name }) =>
        fs.unlink(path.join(dir, name)).catch(() => {
          // A failed delete just leaves this file for the next prune pass.
        })
      )
    );
  } catch {
    // Tolerant: a prune failure must never fail the save that triggered it.
  }
}

function toSummary(snapshot: RunSnapshot): RunSummary | null {
  const config = snapshot.config;
  if (!config) return null;
  return {
    runId: config.runId,
    projectPath: config.projectPath,
    targetUrl: config.targetUrl,
    mode: config.mode,
    status: snapshot.status,
    startedAt: snapshot.telemetry.startedAt,
    findings: snapshot.findings.length,
    tests: snapshot.tests.length,
  };
}

/**
 * Lists every persisted run as a lightweight `RunSummary`, newest-first
 * (by `startedAt`; runs that never started sort last). Tolerant: a missing
 * runs directory yields `[]`, and any single corrupt/partial/non-JSON file
 * is skipped rather than failing the whole listing.
 */
export async function listRuns(dir: string): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const summaries: RunSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const snapshot = JSON.parse(raw) as RunSnapshot;
      const summary = toSummary(snapshot);
      if (summary) summaries.push(summary);
    } catch {
      // Corrupt/partial file (e.g. a crash mid-write of a non-atomic
      // writer, or manual tampering) — skip it, don't crash the listing.
    }
  }

  summaries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return summaries;
}

/**
 * Loads one persisted run's full snapshot, or `null` if missing/unreadable/
 * corrupt — or if `runId` would resolve outside `dir` (path traversal).
 */
export async function loadRun(dir: string, runId: string): Promise<RunSnapshot | null> {
  const target = resolveInsideDir(dir, runId);
  if (!target) return null;
  try {
    const raw = await fs.readFile(target, 'utf8');
    return JSON.parse(raw) as RunSnapshot;
  } catch {
    return null;
  }
}
