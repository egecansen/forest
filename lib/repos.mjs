// lib/repos.mjs — the user's curated repo list, stored in repos.json beside
// config.json. Forest owns this file; config.json stays hand-authored and is
// never rewritten from the UI.
import { readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { withOpLock } from './oplock.mjs';
import { isRenderableRepo } from './discover.mjs';

const FILE = 'repos.json';

const MESSAGES = {
  'not-absolute': 'Enter an absolute path — a relative one would resolve against the server, not your repo.',
  'not-found': 'No such directory.',
  'not-a-repo': 'That directory is not a git repository.',
  // toplevel is the real repo root `git rev-parse --show-toplevel` found —
  // a distinct reason from 'not-a-repo' because the fix here is "add the
  // other path", not "this isn't a repo at all".
  'inside-repo': (info) => `That path is inside ${info.toplevel} — add that instead.`,
  'already-listed': 'Already added.',
  'list-unreadable': 'repos.json is unreadable — fix or delete it, then try again.',
};

export const repoErrorMessage = (reason, info = {}) => {
  const m = MESSAGES[reason];
  if (typeof m === 'function') return m(info);
  return m || 'Could not add that path.';
};

export function expandPath(input) {
  const s = String(input ?? '').trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

// Only used for the rejection message: when a path fails the render
// criterion (isRenderableRepo, imported above), this tells us whether it's
// because the path is *inside* a repo (git can still find a toplevel from
// there) so we can point the user at the real root, versus not a repo at
// all (bare repo, or nothing) where git finds no toplevel either.
const gitToplevel = (path) => new Promise((res) => {
  execFile('git', ['-C', path, 'rev-parse', '--show-toplevel'], (err, stdout) => res(err ? null : stdout.trim()));
});
const real = async (p) => { try { return await realpath(p); } catch { return p; } };

// { repos, malformed } — malformed means the file exists but could not be
// parsed, which is the one case where writing would destroy the user's record.
async function readState(forestRoot) {
  let text;
  try { text = await readFile(join(forestRoot, FILE), 'utf8'); }
  catch { return { repos: [], malformed: false }; }
  try {
    const json = JSON.parse(text);
    // Malformed if not a plain object or repos is not an array
    if (typeof json !== 'object' || json === null || !Array.isArray(json.repos)) {
      return { repos: [], malformed: true };
    }
    // Malformed if array contains non-string elements (would be silently dropped on write)
    if (json.repos.some((p) => typeof p !== 'string')) {
      return { repos: [], malformed: true };
    }
    return { repos: json.repos, malformed: false };
  } catch { return { repos: [], malformed: true }; }
}

// Exposes the { repos, malformed } shape readRepoList discards. server.mjs
// uses this at startup so a corrupt repos.json produces a journal warning
// instead of silently vanishing every listed repo — readRepoList alone gives
// no way to tell "empty because absent" from "empty because unreadable".
export async function readRepoState(forestRoot) {
  return readState(forestRoot);
}

export async function readRepoList(forestRoot) {
  return (await readRepoState(forestRoot)).repos;
}

async function writeRepoList(forestRoot, repos) {
  await writeFile(join(forestRoot, FILE), `${JSON.stringify({ repos }, null, 2)}\n`);
}

// The read-modify-write (readState through writeRepoList) is one critical
// section per forestRoot, serialized with withOpLock: two concurrent adds
// (or an add and a remove) that both read the pre-write list must not each
// write back their own view and silently drop the other's entry — the same
// failure the malformed-file guard above already exists to prevent. The
// validation ahead of the lock (path expansion, absolute check, stat, the
// git-repo check) touches no shared state and is the slow part (gitToplevel
// shells out to git on the rejection path), so it stays outside the lock and
// runs unserialized.
export async function addRepo(forestRoot, input) {
  const path = expandPath(input);
  if (!isAbsolute(path)) return { ok: false, reason: 'not-absolute' };
  let st;
  try { st = await stat(path); } catch { return { ok: false, reason: 'not-found' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'not-found' };
  if (!(await isRenderableRepo(path))) {
    // Not renderable — but is it because the path is *inside* a repo (an
    // ordinary mistake: it's what `pwd` gives you one directory in), or a
    // bare repo / not a repo at all? `rev-parse --show-toplevel` succeeds
    // from a subdirectory and fails inside a bare repo (no work tree), which
    // is exactly the distinction we need.
    const toplevel = await gitToplevel(path);
    if (toplevel && (await real(toplevel)) !== (await real(path))) {
      return { ok: false, reason: 'inside-repo', toplevel };
    }
    return { ok: false, reason: 'not-a-repo' };
  }

  return withOpLock(forestRoot, async () => {
    const { repos, malformed } = await readState(forestRoot);
    if (malformed) return { ok: false, reason: 'list-unreadable' };
    const key = await real(path);
    for (const r of repos) if ((await real(r)) === key) return { ok: false, reason: 'already-listed' };

    const next = [...repos, path];
    await writeRepoList(forestRoot, next);
    return { ok: true, repos: next };
  });
}

export async function removeRepo(forestRoot, input) {
  return withOpLock(forestRoot, async () => {
    const { repos, malformed } = await readState(forestRoot);
    if (malformed) return { ok: false, reason: 'list-unreadable' };
    const key = await real(expandPath(input));
    const next = [];
    for (const r of repos) if ((await real(r)) !== key) next.push(r);
    if (next.length !== repos.length) await writeRepoList(forestRoot, next);
    return { ok: true, repos: next };
  });
}
