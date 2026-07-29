// lib/repos.mjs — the user's curated repo list, stored in repos.json beside
// config.json. Forest owns this file; config.json stays hand-authored and is
// never rewritten from the UI.
import { readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

const FILE = 'repos.json';

const MESSAGES = {
  'not-absolute': 'Enter an absolute path — a relative one would resolve against the server, not your repo.',
  'not-found': 'No such directory.',
  'not-a-repo': 'That directory is not a git repository.',
  'already-listed': 'Already added.',
  'list-unreadable': 'repos.json is unreadable — fix or delete it, then try again.',
};

export const repoErrorMessage = (reason) => MESSAGES[reason] || 'Could not add that path.';

export function expandPath(input) {
  const s = String(input ?? '').trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  return s;
}

const isGitRepo = (path) => new Promise((res) => execFile('git', ['-C', path, 'rev-parse', '--git-dir'], (err) => res(!err)));
const real = async (p) => { try { return await realpath(p); } catch { return p; } };

// { repos, malformed } — malformed means the file exists but could not be
// parsed, which is the one case where writing would destroy the user's record.
async function readState(forestRoot) {
  let text;
  try { text = await readFile(join(forestRoot, FILE), 'utf8'); }
  catch { return { repos: [], malformed: false }; }
  try {
    const json = JSON.parse(text);
    const repos = Array.isArray(json.repos) ? json.repos.filter((p) => typeof p === 'string') : [];
    return { repos, malformed: false };
  } catch { return { repos: [], malformed: true }; }
}

export async function readRepoList(forestRoot) {
  return (await readState(forestRoot)).repos;
}

async function writeRepoList(forestRoot, repos) {
  await writeFile(join(forestRoot, FILE), `${JSON.stringify({ repos }, null, 2)}\n`);
}

export async function addRepo(forestRoot, input) {
  const path = expandPath(input);
  if (!isAbsolute(path)) return { ok: false, reason: 'not-absolute' };
  let st;
  try { st = await stat(path); } catch { return { ok: false, reason: 'not-found' }; }
  if (!st.isDirectory()) return { ok: false, reason: 'not-found' };
  if (!(await isGitRepo(path))) return { ok: false, reason: 'not-a-repo' };

  const { repos, malformed } = await readState(forestRoot);
  if (malformed) return { ok: false, reason: 'list-unreadable' };
  const key = await real(path);
  for (const r of repos) if ((await real(r)) === key) return { ok: false, reason: 'already-listed' };

  const next = [...repos, path];
  await writeRepoList(forestRoot, next);
  return { ok: true, repos: next };
}

export async function removeRepo(forestRoot, input) {
  const { repos, malformed } = await readState(forestRoot);
  if (malformed) return { ok: false, reason: 'list-unreadable' };
  const key = await real(expandPath(input));
  const next = [];
  for (const r of repos) if ((await real(r)) !== key) next.push(r);
  if (next.length !== repos.length) await writeRepoList(forestRoot, next);
  return { ok: true, repos: next };
}
