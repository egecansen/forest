// session-scope.mjs — what a Claude Code session started in a worktree will
// actually load, and whether each registered hook resolves to a real file.
//
// Claude Code merges .claude/settings.json + settings.local.json from the
// session directory AND every ancestor directory, then the user-level file.
// Hook commands are written against $CLAUDE_PROJECT_DIR, which points at the
// session directory — so a hook registered by an ancestor repo resolves into
// the worktree, where the script usually does not exist. That mismatch is
// non-blocking at runtime (exit 127), which is exactly why it goes unnoticed.
import { readFile, stat, realpath, readdir, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function key(file) {
  try { return await realpath(file); } catch { return file; }
}

// First token of a hook command with $CLAUDE_PROJECT_DIR and ~ expanded.
// Returns null when the command is not a file invocation (inline shell, a bare
// executable name) — those are reported, never counted as missing.
export function resolveHookFile(command, worktreePath, home = homedir()) {
  const raw = String(command || '').trim();
  const m = raw.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  if (!m) return null;
  let tok = m[1] ?? m[2] ?? m[3];
  tok = tok.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g, worktreePath);
  if (tok === '~') tok = home;
  else if (tok.startsWith('~/')) tok = join(home, tok.slice(2));
  return isAbsolute(tok) ? tok : null;
}

// The primary repository root of a LINKED git worktree, or null. A linked
// worktree's `.git` is a file — `gitdir: <repo>/.git/worktrees/<name>` — and
// Claude Code resolves it to merge the primary checkout's .claude/settings*
// into the session. A primary checkout's `.git` is a directory, so the
// readFile fails and this correctly answers null.
async function primaryRepoRoot(worktreePath) {
  try {
    const m = String(await readFile(join(worktreePath, '.git'), 'utf8')).match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const i = m[1].lastIndexOf('/.git/worktrees/');
    return i === -1 ? null : m[1].slice(0, i);
  } catch { return null; }
}

// Every settings file that applies to a session rooted at worktreePath, in
// merge order, deduplicated by real path (the worktree root lives under $HOME,
// so the user file is reachable both as an ancestor and as itself).
//
// The primary repo's directory is part of that merge even though it is NOT a
// filesystem ancestor of a forest worktree (those live under ~/.forest).
// Missing it is how a stale registration in the main checkout spammed every
// worktree session for a day while each worktree's own files audited clean —
// the launch guard can only warn about a source it models (2026-08-05).
export async function settingsSources(worktreePath, userSettingsPath) {
  const dirs = [];
  for (let d = worktreePath; ; d = dirname(d)) {
    dirs.push(d);
    if (dirname(d) === d) break;
  }
  const repoRoot = await primaryRepoRoot(worktreePath);
  if (repoRoot) dirs.push(repoRoot);
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    for (const name of SETTINGS_FILES) {
      const file = join(dir, '.claude', name);
      const json = await readJson(file);
      if (!json) continue;
      const k = await key(file);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ file, json });
    }
  }
  const userFile = userSettingsPath || join(homedir(), '.claude', 'settings.json');
  const userJson = await readJson(userFile);
  if (userJson) {
    const k = await key(userFile);
    if (!seen.has(k)) { seen.add(k); out.push({ file: userFile, json: userJson }); }
  }
  return out;
}

// The slug argument of a dispatcher registration ("...dispatch.sh" <slug>) —
// null when the command is not a dispatcher invocation or carries no sane slug.
function dispatchSlug(command) {
  const rest = String(command || '').trim().replace(/^("[^"]+"|'[^']+'|\S+)\s*/, '');
  const slug = rest.split(/\s+/)[0] || '';
  return /^[A-Za-z0-9_-]+$/.test(slug) ? slug : null;
}

// A dispatcher registration answers "does dispatch.sh exist" trivially and
// would hide the real question, so it expands to its <slug>.d entries: each
// symlink whose target resolves is an active gate, each broken one is
// missing (file = the absent target, source = the symlink to fix). The
// dispatcher line itself is never counted as a gate.
async function expandDispatch(resolved, command, event, matcher, active, missing) {
  const dDir = join(dirname(resolved), `${dispatchSlug(command)}.d`);
  let names = [];
  try { names = (await readdir(dDir)).sort(); } catch { return; /* nothing wired */ }
  for (const name of names) {
    const link = join(dDir, name);
    // Resolve only the link text, not the whole path: the rest of this module
    // never canonicalizes (/var vs /private/var on macOS), so neither do we.
    let target = link;
    try { target = resolve(dDir, await readlink(link)); } catch { /* a plain file, not a symlink */ }
    const rec = { event, matcher, command: target, source: link, file: target };
    try {
      if ((await stat(link)).isFile()) active.push(rec);   // follows the link
    } catch { missing.push(rec); }
  }
}

export async function resolveSessionScope(worktreePath, { userSettingsPath } = {}) {
  const sources = await settingsSources(worktreePath, userSettingsPath);
  const active = [], missing = [], inline = [];
  const seen = new Set();
  for (const { file, json } of sources) {
    for (const [event, blocks] of Object.entries(json.hooks || {})) {
      for (const block of Array.isArray(blocks) ? blocks : []) {
        const matcher = block.matcher || '*';
        for (const h of Array.isArray(block.hooks) ? block.hooks : []) {
          const id = `${event}|${matcher}|${h.command}`;
          if (seen.has(id)) continue;            // Claude Code runs a duplicate registration once
          seen.add(id);
          const rec = { event, matcher, command: h.command, source: file };
          const resolved = resolveHookFile(h.command, worktreePath);
          if (!resolved) { inline.push(rec); continue; }
          rec.file = resolved;
          if (basename(resolved) === 'dispatch.sh' && dispatchSlug(h.command)) {
            try { await stat(resolved); } catch { missing.push(rec); continue; }
            await expandDispatch(resolved, h.command, event, matcher, active, missing);
            continue;
          }
          try { await stat(resolved); active.push(rec); } catch { missing.push(rec); }
        }
      }
    }
  }
  return { active, missing, inline, sources: sources.map((s) => s.file) };
}

// The Cursor harness's own registry: .cursor/hooks.json, written whole by
// the pack's install.sh. Same question resolveSessionScope answers for
// .claude/ — "which registered gate scripts are actually on disk?" — but
// there is exactly one file and no inheritance, so no sources/inline split.
// A `./`-relative command is resolved against the worktree and stat-ed;
// anything else (absolute, or a bare name on PATH) is taken as active:
// forest cannot judge it and must not report a working gate as missing.
export async function resolveCursorScope(worktreePath) {
  const file = join(worktreePath, '.cursor', 'hooks.json');
  const cfg = await readJson(file);
  if (!cfg || typeof cfg !== 'object') return { active: [], missing: [], file: null };
  const hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  const active = [], missing = [];
  for (const [event, entries] of Object.entries(hooks)) {
    for (const h of Array.isArray(entries) ? entries : [entries]) {
      const command = h && typeof h === 'object' && typeof h.command === 'string' ? h.command.trim() : '';
      if (!command) continue;
      const first = command.split(/\s+/)[0];
      if (!first.startsWith('./')) { active.push({ event, command, file: null }); continue; }
      const target = resolve(worktreePath, first);
      let present = false;
      try { await stat(target); present = true; } catch { /* registered but not on disk */ }
      (present ? active : missing).push({ event, command, file: target });
    }
  }
  return { active, missing, file };
}
