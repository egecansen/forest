// lib/prune.mjs — decides which worktrees are safe to delete, and deletes them.
// The rule is deliberately conservative: old AND empty AND unused, all three.
// Worst case we remove a checkout the user must re-create; we never remove one
// holding work.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runGit } from './git.mjs';

const execFileP = promisify(execFile);
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Order matters only in that the first failing condition names the reason.
export function prunable(wt, { staleDays }) {
  if (wt.isPrimary) return { ok: false, reason: 'primary' };
  if (wt.locked) return { ok: false, reason: 'locked' };
  if (wt.agent?.state === 'running') return { ok: false, reason: 'agent-running' };
  if (wt.status?.dirty) return { ok: false, reason: 'dirty' };
  if ((wt.ahead ?? 0) > 0) return { ok: false, reason: 'has-commits' };
  // ageDays === null means "no commit to date it by" — treat as too recent, so
  // a freshly created empty worktree is never swept up.
  if (wt.ageDays == null || wt.ageDays < staleDays) return { ok: false, reason: 'too-recent' };
  return { ok: true };
}

export function selectCandidates(worktrees, { staleDays }) {
  const candidates = [];
  const kept = [];
  for (const wt of worktrees) {
    const v = prunable(wt, { staleDays });
    if (v.ok) candidates.push(wt);
    else kept.push({ path: wt.path, reason: v.reason });
  }
  return { candidates, kept };
}

// Guided mode shows the user exactly what auto mode would run.
export function pruneCommands({ repoPath, targets }) {
  const out = [];
  for (const t of targets) {
    out.push(`git -C ${shQuote(repoPath)} worktree remove ${shQuote(t.path)}`);
    if (!t.detached && t.branch) out.push(`git -C ${shQuote(repoPath)} branch -d ${shQuote(t.branch)}`);
  }
  return out;
}

// `du -sk` on demand. The snapshot's sizeBytes is always null (server.mjs
// creates the sizes map and never fills it), and filling it on the 4s loop
// would add a du per worktree to the very storm pruning exists to reduce.
export async function dirSizeBytes(path) {
  try {
    const { stdout } = await execFileP('du', ['-sk', path]);
    const kb = parseInt(stdout.trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

// Deletes only what still satisfies `prunable` at this moment, re-checked
// against freshly-read records — never on the evidence the preview showed,
// which may be seconds stale.
export async function pruneWorktrees({ repoPath, paths, worktrees, staleDays, onStep = () => {} }) {
  const removed = [], skipped = [], failed = [];
  const byPath = new Map(worktrees.map((w) => [w.path, w]));

  for (const path of paths) {
    const wt = byPath.get(path);
    // No record for this path: it is not a worktree of this repo as far as we
    // know, so it is not ours to delete.
    if (!wt) { skipped.push({ path, reason: 'unknown' }); continue; }
    const v = prunable(wt, { staleDays });
    if (!v.ok) { skipped.push({ path, reason: v.reason }); continue; }

    onStep({ cmd: `git worktree remove ${path}`, cwd: repoPath });
    try {
      await runGit(repoPath, ['worktree', 'remove', path]);
    } catch (e) {
      // Branch deletion is skipped deliberately: a deleted branch with a
      // surviving worktree is worse than an un-pruned pair.
      failed.push({ path, step: 'worktree-remove', error: String(e) });
      continue;
    }

    if (!wt.detached && wt.branch) {
      onStep({ cmd: `git branch -d ${wt.branch}`, cwd: repoPath });
      try {
        await runGit(repoPath, ['branch', '-d', wt.branch]);
      } catch (e) {
        // -d refusing here means the predicate was wrong about this branch.
        // The worktree is already gone; report and keep going.
        failed.push({ path, step: 'branch-delete', error: String(e) });
      }
    }
    removed.push({ path, branch: wt.branch ?? null });
  }
  return { removed, skipped, failed };
}
