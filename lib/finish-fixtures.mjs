// lib/finish-fixtures.mjs — shared test fixtures for finish.test.mjs and
// landed.test.mjs. Moved out of finish.test.mjs so importing it doesn't
// re-run finish.test.mjs's own top-level test() registrations.
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { slug } from './finish.mjs';

const execFileP = promisify(execFile);
export async function git(cwd, ...args) {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args]);
  return stdout;
}
// Fixture: a primary repo with one commit on master and a worktree holding
// <branch>. `root` defaults to the legacy in-repo location; pass an out-of-tree
// root to exercise the isolated layout. Caller must rm() both.
export async function makeRepoWithWorktree({ branch = 'tech/WEBT-1', root } = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'forest-finish-'));
  await git(repo, 'init', '-b', 'master');
  await git(repo, 'config', 'user.email', 't@t');
  await git(repo, 'config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'base\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const wtRoot = root || join(repo, '.forest', 'wt');
  await mkdir(wtRoot, { recursive: true });
  const wt = join(wtRoot, slug(branch));
  await git(repo, 'worktree', 'add', '-b', branch, wt, 'HEAD');
  return { repo, wt, branch };
}
export async function commitFile(cwd, name, content, msg) {
  await writeFile(join(cwd, name), content);
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', msg);
}
