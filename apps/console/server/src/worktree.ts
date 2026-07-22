import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeFile {
  status: string;
  path: string;
}

export interface WorktreeResult {
  files: WorktreeFile[];
  diff: string;
  truncated: boolean;
}

// Mirrors index.ts's FILE_VIEW_CAP for the Files-tab single-file viewer — the
// same 512KB ceiling, applied here to the whole unified diff payload.
export const WORKTREE_DIFF_CAP = 512 * 1024;

// A diff can legitimately exceed Node's default 1MB exec buffer before our
// own cap ever gets a chance to trim it — allow headroom so `execFile`
// itself doesn't throw on a large (pre-truncation) diff.
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Working-tree diff for a run's project repo: `git diff HEAD --name-status` (the
 * changed-file list) plus `git diff HEAD` (the full unified diff) — i.e. the
 * diff from the last committed state (HEAD) to the working tree, capturing both
 * staged (via `git add`) and unstaged changes. Read-only: never mutates the repo.
 * Runs via `execFile` (no shell) so `projectPath` can never smuggle in shell
 * metacharacters. Tolerant: any git failure (not a repo, git missing, empty
 * history) yields the same empty result a clean tree would.
 */
export async function getWorktree(projectPath: string): Promise<WorktreeResult> {
  const [nameStatus, diff] = await Promise.all([
    runGit(projectPath, ['diff', 'HEAD', '--name-status']),
    runGit(projectPath, ['diff', 'HEAD']),
  ]);
  const files = parseNameStatus(nameStatus);
  const truncated = diff.length > WORKTREE_DIFF_CAP;
  return {
    files,
    diff: truncated ? diff.slice(0, WORKTREE_DIFF_CAP) : diff,
    truncated,
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch {
    // Not a git repo, no HEAD yet, git missing, etc. — treat like a clean
    // tree rather than failing the whole request.
    return '';
  }
}

function parseNameStatus(raw: string): WorktreeFile[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      // For rename (R*) and copy (C*) statuses, the format is: R[score]\told\tnew
      // Take the destination (LAST field); for other statuses take the first path field.
      const path = status.match(/^[RC]/) ? parts[parts.length - 1] : parts[1] ?? '';
      return { status, path };
    });
}
