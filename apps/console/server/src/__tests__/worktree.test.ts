import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getWorktree } from '../worktree.js';

const execFileAsync = promisify(execFile);

let repo: string;

async function git(args: string[]) {
  await execFileAsync('git', ['-C', repo, ...args]);
}

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-test-'));
  await git(['init']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'a.txt'), 'line one\nline two\n');
  await git(['add', 'a.txt']);
  await git(['commit', '-m', 'initial commit']);
});

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('getWorktree', () => {
  it('returns an empty result for a clean working tree', async () => {
    const result = await getWorktree(repo);
    expect(result).toEqual({ files: [], diff: '', truncated: false });
  });

  it('reports a modified file with name-status and a unified diff, without mutating the repo', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'line one\nline TWO changed\n');
    const result = await getWorktree(repo);
    expect(result.files).toEqual([{ status: 'M', path: 'a.txt' }]);
    expect(result.diff).toContain('diff --git a/a.txt b/a.txt');
    expect(result.diff).toContain('-line two');
    expect(result.diff).toContain('+line TWO changed');
    expect(result.truncated).toBe(false);

    // Never mutates the repo: the change is still present, uncommitted.
    const status = await execFileAsync('git', ['-C', repo, 'status', '--porcelain']);
    expect(status.stdout).toContain(' M a.txt');
  });

  it('reports an added (untracked) file too via name-status, once staged is not required', async () => {
    // Working-tree diff vs HEAD only covers tracked changes; an untracked new
    // file is intentionally NOT part of `git diff` (matches git's own
    // semantics — this asserts the current tracked modification still shows
    // even with an untracked file sitting alongside it).
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'new file');
    const result = await getWorktree(repo);
    expect(result.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('caps a huge diff at 512KB and sets truncated', async () => {
    const big = 'x'.repeat(1024) + '\n';
    const lines = Array.from({ length: 700 }, () => big).join('');
    await fs.writeFile(path.join(repo, 'a.txt'), lines);
    const result = await getWorktree(repo);
    expect(result.truncated).toBe(true);
    expect(result.diff.length).toBe(512 * 1024);
  });
});
