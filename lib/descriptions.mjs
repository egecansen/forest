// lib/descriptions.mjs — per-repo store of user-written worktree descriptions
//
// Only overrides live here. The auto-composed text (ticket title + browse link)
// is regenerated on every read, so it can never go stale and there is no cache
// to invalidate: what the drawer shows is `override ?? generated`.
//
// Keyed by branch, not by worktree path — a description belongs to the work, so
// it survives `worktree remove` plus re-creation, and survives finish moving the
// branch into the main checkout. Detached worktrees key by path instead.
//
// Storage mirrors lib/landed.mjs exactly: same file location convention, same
// atomic write, same per-repo lock.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { jiraKey, browseUrl, composeDescription } from './jira.mjs';

const file = (repoPath) => join(repoPath, '.forest', 'descriptions.json');

// In-process serialization, as in landed.mjs: chains callers onto the repo's
// pending promise so concurrent save/clear on one repo never interleave their
// read-modify-write. readDescriptions stays lock-free.
const queues = new Map();
function withRepoLock(repoPath, fn) {
  const prev = queues.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(repoPath, next);
  // Both-branches observer rather than .finally(), which would derive a promise
  // nobody awaits and turn a handled rejection into an unhandled one.
  const cleanup = () => { if (queues.get(repoPath) === next) queues.delete(repoPath); };
  next.then(cleanup, cleanup);
  return next;
}

export async function readDescriptions(repoPath) {
  try {
    const parsed = JSON.parse(await readFile(file(repoPath), 'utf8'));
    // A hand-edited file could hold anything; only a plain object is usable.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}

// null means "no override" — distinct from '', which is a deliberate blank.
export async function readDescription(repoPath, key) {
  const all = await readDescriptions(repoPath);
  return Object.hasOwn(all, key) ? String(all[key]) : null;
}

async function write(repoPath, entries) {
  const target = file(repoPath);
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `descriptions.json.tmp-${process.pid}`);
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`);
  await rename(tmp, target);
}

export async function saveDescription(repoPath, key, text) {
  return withRepoLock(repoPath, async () => {
    const all = await readDescriptions(repoPath);
    all[key] = String(text ?? '');
    await write(repoPath, all);
  });
}

export async function clearDescription(repoPath, key) {
  return withRepoLock(repoPath, async () => {
    const all = await readDescriptions(repoPath);
    if (!Object.hasOwn(all, key)) return;
    delete all[key];
    await write(repoPath, all);
  });
}

// A detached worktree has no branch to key on, so it falls back to its path.
// That description dies with the directory, which is the best available
// behaviour for a checkout that has no name to survive under.
export function descriptionKey(worktree) {
  return worktree.branch || worktree.path;
}

// What the drawer shows for one worktree: the user's override when there is
// one, otherwise text composed from the branch's ticket. Never throws, and
// never blocks on Jira when an override already answers the question.
export async function resolveDescription({ worktree, config, cache }) {
  const ticket = jiraKey(worktree.ticket, config.jiraProjectKey);
  const url = browseUrl(config.jiraBaseUrl, ticket);
  const override = await readDescription(worktree.repoPath, descriptionKey(worktree));
  if (override !== null) return { text: override, override: true, ticket, url };
  const { summary, error } = await cache.get(ticket, {
    baseUrl: config.jiraBaseUrl, token: config.jiraToken, email: config.jiraEmail,
  });
  return { text: composeDescription({ summary, url }), override: false, ticket, url, jiraError: error };
}
