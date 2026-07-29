// session-scope.mjs — what a Claude Code session started in a worktree will
// actually load, and whether each registered hook resolves to a real file.
//
// Claude Code merges .claude/settings.json + settings.local.json from the
// session directory AND every ancestor directory, then the user-level file.
// Hook commands are written against $CLAUDE_PROJECT_DIR, which points at the
// session directory — so a hook registered by an ancestor repo resolves into
// the worktree, where the script usually does not exist. That mismatch is
// non-blocking at runtime (exit 127), which is exactly why it goes unnoticed.
import { readFile, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

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

// Every settings file that applies to a session rooted at worktreePath, in
// merge order, deduplicated by real path (the worktree root lives under $HOME,
// so the user file is reachable both as an ancestor and as itself).
export async function settingsSources(worktreePath, userSettingsPath) {
  const dirs = [];
  for (let d = worktreePath; ; d = dirname(d)) {
    dirs.push(d);
    if (dirname(d) === d) break;
  }
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
          try { await stat(resolved); active.push(rec); } catch { missing.push(rec); }
        }
      }
    }
  }
  return { active, missing, inline, sources: sources.map((s) => s.file) };
}
