// lib/landed.mjs — ledger of landings, backing Eject and safety-ref pruning
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { runGit } from './git.mjs';

const file = (repoPath) => join(repoPath, '.forest', 'landed.json');

// In-process serialization: chains callers onto the repo's pending promise
// so concurrent recordLanding/popLanding/pruneLandings on the same repoPath
// never interleave their read-modify-write. readLandings stays lock-free.
const queues = new Map();
function withRepoLock(repoPath, fn) {
  const prev = queues.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(repoPath, next);
  // Both-branches observer instead of next.finally(cb): .finally() derives a
  // new promise that is never awaited by anyone, so when `fn` rejects (a
  // locked call failing) that derived promise rejects unhandled and kills
  // the process under --unhandled-rejections=throw even though the caller
  // (which awaits `next`, returned below) handled the rejection.
  const cleanup = () => { if (queues.get(repoPath) === next) queues.delete(repoPath); };
  next.then(cleanup, cleanup);
  return next;
}

export async function readLandings(repoPath) {
  try { return JSON.parse(await readFile(file(repoPath), 'utf8')); }
  catch { return []; }
}
// Atomic write: write to a same-directory temp file, then rename over the
// target. rename() is atomic on the same filesystem, so a reader never sees
// a torn/partial write, and our own writes can never corrupt landed.json.
async function write(repoPath, entries) {
  const target = file(repoPath);
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `landed.json.tmp-${process.pid}`);
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  await rename(tmp, target);
}
export async function recordLanding(repoPath, entry) {
  return withRepoLock(repoPath, async () => {
    const entries = await readLandings(repoPath);
    entries.push(entry);
    await write(repoPath, entries);
  });
}
export async function popLanding(repoPath) {
  return withRepoLock(repoPath, async () => {
    const entries = await readLandings(repoPath);
    const last = entries.pop() ?? null;
    if (last) await write(repoPath, entries);
    return last;
  });
}
export async function pruneLandings(repoPath, { maxAgeDays = 14, now = Date.now() } = {}) {
  return withRepoLock(repoPath, async () => {
    const entries = await readLandings(repoPath);
    const keep = [];
    for (const e of entries) {
      if (now - e.ts <= maxAgeDays * 86_400_000) { keep.push(e); continue; }
      const refName = `refs/forest/landed/${e.worktreeName}`;
      const exists = (await runGit(repoPath, ['show-ref', '--verify', '--quiet', refName]).then(() => true, () => false));
      let deleted = !exists; // absent ref: nothing to delete, treat as success
      if (exists) {
        deleted = await runGit(repoPath, ['update-ref', '-d', refName]).then(() => true, () => false);
      }
      if (!deleted) { keep.push(e); continue; } // genuine failure: retry next prune
    }
    if (keep.length !== entries.length) await write(repoPath, keep);
  });
}
