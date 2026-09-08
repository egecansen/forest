import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function runGit(cwd, args) {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

// The branch a repo's work is cut from and measured against: origin's declared
// default if there is one, else a local main/master. Falls back to 'HEAD' —
// which means "whatever this checkout has out right now", the only honest
// answer when nothing else resolves, and deliberately NOT a default anything
// should reach for while a real base branch exists.
export async function baseBranch(repoPath) {
  try {
    const out = (await runGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    if (out) return out.replace('refs/remotes/origin/', '');
  } catch { /* fall through */ }
  for (const b of ['main', 'master']) {
    try { await runGit(repoPath, ['rev-parse', '--verify', b]); return b; } catch { /* next */ }
  }
  return 'HEAD';
}

export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function parseStatus(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  let staged = 0;
  for (const l of lines) {
    const x = l[0];
    if (x !== ' ' && x !== '?') staged++;
  }
  return { changed: lines.length, staged, dirty: lines.length > 0 };
}

export function parseAheadBehind(text) {
  const [left, right] = text.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ahead: right || 0, behind: left || 0 };
}

export function extractTicket(branch) {
  if (!branch) return null;
  const m = branch.match(/([A-Z][A-Z0-9]*-\d+)/);
  return m ? m[1] : null;
}

export function detectOwner(path) {
  if (path.includes('/.cursor/worktrees/')) return 'cursor';
  if (path.includes('/.claude/worktrees/')) return 'claude';
  return 'user';
}
