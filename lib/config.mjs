import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, resolve, join } from 'node:path';

// Portable defaults: no machine-specific paths baked in.
// Forest usually lives at <root>/APPS/forest, so the deck root defaults to
// <root> (forest's grandparent) — works out of the box wherever it's cloned
// under that layout. Override any key via config.json or FOREST_* env vars.
const FOREST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_ROOT = resolve(FOREST_DIR, '..', '..');

const splitList = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

export const DEFAULTS = {
  port: Number(process.env.FOREST_PORT) || 5577,
  roots: splitList(process.env.FOREST_ROOTS) || [INSTALL_ROOT],
  containers: splitList(process.env.FOREST_CONTAINERS) || ['APPS'], // non-git folders whose children are each listed as repos
  packsDir: process.env.FOREST_PACKS_DIR || join(INSTALL_ROOT, 'SKLS'), // skill packs (each subdir has catalog.json + skills/ + kits/)
  // Worktrees live OUTSIDE every repo tree: a session started inside a repo
  // inherits that repo's .claude/settings.json (Claude Code merges ancestor
  // settings) while $CLAUDE_PROJECT_DIR points at the worktree, so every hook
  // script that was not provisioned there fails with exit 127.
  worktreeRoot: process.env.FOREST_WORKTREE_ROOT || join(homedir(), '.forest', 'wt'),
  jiraBaseUrl: process.env.FOREST_JIRA_URL || '',
  // Branch names carry a team prefix by convention (tech/WEBT-229553) while the
  // issues may all live in one project. Empty = use the branch's own key.
  jiraProjectKey: process.env.FOREST_JIRA_PROJECT_KEY || '',
  // Credential for reading issue summaries. Never served to the browser —
  // server.mjs strips it from /api/config.
  jiraToken: process.env.FOREST_JIRA_TOKEN || '',
  // Set only for Jira Cloud, which wants Basic email:token instead of a Bearer PAT.
  jiraEmail: process.env.FOREST_JIRA_EMAIL || '',
  staleDays: 14,
  defaultMode: 'guided',
  terminalApp: 'Terminal',
  openEditorCmd: 'open -a Cursor',
  setupScript: '.forest-setup.sh',
};

export function mergeConfig(user = {}) {
  return { ...DEFAULTS, ...user };
}

// The subset of config the dashboard is allowed to see. /api/config is served
// to the browser, so every credential has to be stripped here — the Jira
// summary fetch happens server-side and the client never needs the token.
const SECRET_KEYS = ['jiraToken'];
export function publicConfig(config) {
  const out = { ...config };
  for (const k of SECRET_KEYS) delete out[k];
  return out;
}

export async function loadConfig(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // surface unexpected I/O errors
    return mergeConfig({});
  }
  return mergeConfig(JSON.parse(text)); // let parse errors surface
}

// Absolute path for a repo's worktree: <worktreeRoot>/<repo dir name>/<branch slug>.
export function worktreePathFor({ worktreeRoot, repoPath, branchSlug }) {
  return join(worktreeRoot, basename(repoPath), branchSlug);
}
