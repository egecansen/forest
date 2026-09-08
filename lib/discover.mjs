import { readdir, access, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  runGit, parseWorktreeList, parseStatus, parseAheadBehind, extractTicket, detectOwner, baseBranch,
} from './git.mjs';
import { detectAgentState } from './agents.mjs';
import { readLandings } from './landed.mjs';
import { readPriorities, priorityKey } from './priorities.mjs';
import { resolveSessionScope } from './session-scope.mjs';
import { readTicketStatus } from './ticket-status.mjs';

const DAY = 86_400_000;

export function staleFrom({ merged, lastCommitMs, nowMs, staleDays }) {
  if (merged) return true;
  if (!lastCommitMs) return false;
  return nowMs - lastCommitMs > staleDays * DAY;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// The single render criterion: forest can only show a path as a repo when a
// literal `.git` entry sits directly under it (worktree checkouts have this
// as a file; ordinary repos as a directory). This is deliberately narrower
// than "git considers this a repo" — `git rev-parse --git-dir` also
// succeeds from any subdirectory of a repo and inside a bare repo, neither
// of which has a `.git` entry of its own and neither of which this
// predicate (or forest) can render. lib/repos.mjs imports this so addRepo's
// accept criterion can never drift from what actually shows up in the UI.
export async function isRenderableRepo(path) {
  return exists(join(path, '.git'));
}

// A "container" (e.g. APPS) is a non-git folder that groups several independent
// repos; we descend one level into it so each nested app appears on its own.
export async function listRepoDirs(root, containers = []) {
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const containerSet = new Set(containers.map((c) => c.toLowerCase()));
  const repos = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(root, e.name);
    if (await isRenderableRepo(path)) { repos.push({ name: e.name, path }); continue; }
    if (containerSet.has(e.name.toLowerCase())) {
      let subs = [];
      try { subs = await readdir(path, { withFileTypes: true }); } catch { subs = []; }
      for (const s of subs) {
        if (!s.isDirectory()) continue;
        const sp = join(path, s.name);
        if (await isRenderableRepo(sp)) repos.push({ name: s.name, path: sp });
      }
    }
  }
  return repos;
}

async function safe(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

async function buildWorktreeRecord(repoName, repoPath, wt, ctx) {
  const { registry, nowMs, claudeProjectsDir, staleDays } = ctx;
  const path = wt.path;
  const isPrimary = path === repoPath;
  const base = ctx.base;

  const statusText = await safe(() => runGit(path, ['status', '--porcelain=v1']), '');
  const status = parseStatus(statusText);

  let ahead = 0, behind = 0, merged = false, lastCommitMs = 0;
  // Detached worktrees are counted too. Reporting a hardcoded ahead: 0 for them
  // made a detached HEAD holding unmerged commits look empty — and a detached
  // HEAD's commits are referenced only by its worktree, so anything acting on
  // that count (the prune button) would have destroyed them silently.
  if (wt.branch || wt.detached) {
    const ab = await safe(() => runGit(path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]), '0\t0');
    ({ ahead, behind } = parseAheadBehind(ab));
    // A branch resolves from the primary checkout; a detached HEAD only
    // resolves from inside the worktree that holds it.
    merged = await safe(async () => {
      await runGit(wt.branch ? repoPath : path, ['merge-base', '--is-ancestor', wt.branch || 'HEAD', base]);
      return true;
    }, false);
  }
  const lastCommitIso = (await safe(() => runGit(path, ['log', '-1', '--format=%cI']), '')).trim();
  if (lastCommitIso) lastCommitMs = Date.parse(lastCommitIso);

  const agent = await safe(() => detectAgentState({ worktreePath: path, claudeProjectsDir, nowMs, registry }), { state: 'unknown', kind: null, source: null, pid: null });

  const scopeFull = await safe(() => resolveSessionScope(path), { active: [], missing: [], inline: [], sources: [] });
  const scope = { active: scopeFull.active.length, missing: scopeFull.missing.length };

  const ticket = extractTicket(wt.branch);
  // stat-cheap (in-process, no subprocess) and mtime-cached by the caller —
  // see lib/ticket-status.mjs for why this is safe to leave on the periodic
  // snapshot loop, unlike sizeBytes below. A worktree with no ticket, or a
  // ticket with no brief, costs at most one stat() and comes back null —
  // indistinguishable from a worktree that never had a brief to begin with.
  // `projectKey` re-keys the branch-derived ticket onto the Jira project the
  // brief was actually filed/named under (see readTicketStatus's doc comment
  // for why the two can differ).
  const ticketStatus = await safe(
    () => readTicketStatus(path, ticket, ctx.ticketStatusCache, { projectKey: ctx.jiraProjectKey }),
    null,
  );

  return {
    repo: repoName,
    repoPath,
    path,
    isPrimary,
    branch: wt.branch,
    head: wt.head,
    detached: wt.detached,
    locked: wt.locked,
    owner: detectOwner(path),
    ticket,
    ticketStatus,
    status,
    ahead,
    behind,
    baseBranch: base,
    merged,
    stale: staleFrom({ merged, lastCommitMs, nowMs, staleDays }),
    lastCommitAt: lastCommitIso || null,
    ageDays: lastCommitMs ? Math.floor((nowMs - lastCommitMs) / DAY) : null,
    sizeBytes: ctx.sizes.get(path) ?? null,
    agent,
    scope,
  };
}

const realOrSelf = async (p) => { try { return await realpath(p); } catch { return p; } };

export async function buildSnapshot(config, {
  registry, nowMs, claudeProjectsDir, sizes = new Map(), ticketStatusCache = new Map(), repoList = [],
}) {
  const repos = [];
  const skippedRepos = [];
  const seen = new Set();

  const addRepoRecord = async (name, repoPath, listed) => {
    const key = await realOrSelf(repoPath);
    if (seen.has(key)) return;          // scanned and listed are the same repo
    seen.add(key);
    const listText = await safe(() => runGit(repoPath, ['worktree', 'list', '--porcelain']), '');
    let wts = [];
    try { wts = parseWorktreeList(listText); } catch { wts = []; }
    const base = await safe(() => baseBranch(repoPath), 'HEAD');
    const ctx = {
      registry, nowMs, claudeProjectsDir, staleDays: config.staleDays, base, sizes, ticketStatusCache,
      jiraProjectKey: config.jiraProjectKey,
    };
    const worktrees = [];
    for (const wt of wts) {
      const rec = await safe(() => buildWorktreeRecord(name, repoPath, wt, ctx), null);
      if (rec) worktrees.push(rec);
    }
    // One file read per repo stamps every record — the deck colors rows
    // straight from the snapshot, no extra requests.
    const prios = await safe(() => readPriorities(repoPath), {});
    for (const rec of worktrees) rec.priority = prios[priorityKey(rec)] ?? null;
    const landed = await safe(() => readLandings(repoPath), []);
    repos.push({ repo: name, repoPath, worktrees, landed, listed });
  };

  for (const root of config.roots) {
    for (const { name, path: repoPath } of await listRepoDirs(root, config.containers)) {
      await addRepoRecord(name, repoPath, false);
    }
  }
  for (const p of repoList) {
    if (!(await isRenderableRepo(p))) { skippedRepos.push(p); continue; }
    await addRepoRecord(basename(p), p, true);
  }
  return { repos, generatedAt: nowMs, skippedRepos };
}
