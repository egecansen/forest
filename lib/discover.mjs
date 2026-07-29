import { readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runGit, parseWorktreeList, parseStatus, parseAheadBehind, extractTicket, detectOwner,
} from './git.mjs';
import { detectAgentState } from './agents.mjs';
import { readLandings } from './landed.mjs';

const DAY = 86_400_000;

export function staleFrom({ merged, lastCommitMs, nowMs, staleDays }) {
  if (merged) return true;
  if (!lastCommitMs) return false;
  return nowMs - lastCommitMs > staleDays * DAY;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
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
    if (await exists(join(path, '.git'))) { repos.push({ name: e.name, path }); continue; }
    if (containerSet.has(e.name.toLowerCase())) {
      let subs = [];
      try { subs = await readdir(path, { withFileTypes: true }); } catch { subs = []; }
      for (const s of subs) {
        if (!s.isDirectory()) continue;
        const sp = join(path, s.name);
        if (await exists(join(sp, '.git'))) repos.push({ name: s.name, path: sp });
      }
    }
  }
  return repos;
}

async function baseBranch(repoPath) {
  try {
    const out = (await runGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    if (out) return out.replace('refs/remotes/origin/', '');
  } catch { /* fall through */ }
  for (const b of ['main', 'master']) {
    try { await runGit(repoPath, ['rev-parse', '--verify', b]); return b; } catch { /* next */ }
  }
  return 'HEAD';
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
  if (!wt.detached && wt.branch) {
    const ab = await safe(() => runGit(path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]), '0\t0');
    ({ ahead, behind } = parseAheadBehind(ab));
    merged = await safe(async () => {
      await runGit(repoPath, ['merge-base', '--is-ancestor', wt.branch, base]);
      return true;
    }, false);
  }
  const lastCommitIso = (await safe(() => runGit(path, ['log', '-1', '--format=%cI']), '')).trim();
  if (lastCommitIso) lastCommitMs = Date.parse(lastCommitIso);

  const agent = await safe(() => detectAgentState({ worktreePath: path, claudeProjectsDir, nowMs, registry }), { state: 'unknown', kind: null, source: null, pid: null });

  return {
    repo: repoName,
    repoPath,
    path,
    isPrimary,
    branch: wt.branch,
    head: wt.head,
    detached: wt.detached,
    owner: detectOwner(path),
    ticket: extractTicket(wt.branch),
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
  };
}

export async function buildSnapshot(config, { registry, nowMs, claudeProjectsDir, sizes = new Map() }) {
  const repos = [];
  for (const root of config.roots) {
    for (const { name, path: repoPath } of await listRepoDirs(root, config.containers)) {
      const listText = await safe(() => runGit(repoPath, ['worktree', 'list', '--porcelain']), '');
      let wts = [];
      try { wts = parseWorktreeList(listText); } catch { wts = []; }
      const base = await safe(() => baseBranch(repoPath), 'HEAD');
      const ctx = { registry, nowMs, claudeProjectsDir, staleDays: config.staleDays, base, sizes };
      const worktrees = [];
      for (const wt of wts) {
        const rec = await safe(() => buildWorktreeRecord(name, repoPath, wt, ctx), null);
        if (rec) worktrees.push(rec);
      }
      const landed = await safe(() => readLandings(repoPath), []);
      repos.push({ repo: name, repoPath, worktrees, landed });
    }
  }
  return { repos, generatedAt: nowMs };
}
