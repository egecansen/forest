// lib/priorities.mjs — per-repo store of user-assigned worktree priority colors
//
// A priority is a color label whose meaning belongs entirely to the user; the
// deck renders it, nothing acts on it. Keyed by branch (path for detached
// worktrees) so a label survives `worktree remove` plus re-creation, exactly
// like descriptions. Storage mirrors lib/descriptions.mjs: same file location
// convention, same atomic write, same per-repo lock.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const PRIORITY_COLORS = ['red', 'amber', 'blue', 'green'];

const file = (repoPath) => join(repoPath, '.forest', 'priorities.json');

const queues = new Map();
function withRepoLock(repoPath, fn) {
  const prev = queues.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(repoPath, next);
  const cleanup = () => { if (queues.get(repoPath) === next) queues.delete(repoPath); };
  next.then(cleanup, cleanup);
  return next;
}

export async function readPriorities(repoPath) {
  try {
    const parsed = JSON.parse(await readFile(file(repoPath), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}

async function write(repoPath, entries) {
  const target = file(repoPath);
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `priorities.json.tmp-${process.pid}`);
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  await rename(tmp, target);
}

export async function savePriority(repoPath, key, color) {
  return withRepoLock(repoPath, async () => {
    const all = await readPriorities(repoPath);
    all[key] = String(color);
    await write(repoPath, all);
  });
}

export async function clearPriority(repoPath, key) {
  return withRepoLock(repoPath, async () => {
    const all = await readPriorities(repoPath);
    if (!Object.hasOwn(all, key)) return;
    delete all[key];
    await write(repoPath, all);
  });
}

// Same semantics as descriptions' key: the label belongs to the work, not the
// checkout directory.
export function priorityKey(worktree) {
  return worktree.branch || worktree.path;
}
