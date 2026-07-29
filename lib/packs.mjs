import { readdir, readFile, writeFile, mkdir, cp, copyFile, chmod, stat, appendFile } from 'node:fs/promises';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id);

// List skill packs under packsDir: each subdir that holds a catalog.json.
export async function listPacks(packsDir) {
  let entries = [];
  try { entries = await readdir(packsDir, { withFileTypes: true }); } catch { return []; }
  const packs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(packsDir, e.name);
    try {
      const cat = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'));
      packs.push({ ...cat, pack: cat.pack || e.name, dir });
    } catch { /* not a pack — skip */ }
  }
  return packs;
}

function git(cwd, args) {
  return new Promise((resolve) => execFile('git', ['-C', cwd, ...args], (err, out) => resolve(err ? null : String(out).trim())));
}

// The pack is a private overlay; keep provisioned files out of git. If `.claude`
// isn't already ignored, add it to the worktree's LOCAL git exclude — never the
// tracked .gitignore. Best-effort: failures never block a launch.
async function ensureHidden(worktreePath) {
  try {
    const ignored = await new Promise((res) => execFile('git', ['-C', worktreePath, 'check-ignore', '-q', '.claude/skills'], (err) => res(!err)));
    if (ignored) return;
    const ex = await git(worktreePath, ['rev-parse', '--git-path', 'info/exclude']);
    if (!ex) return;
    const path = isAbsolute(ex) ? ex : join(worktreePath, ex);
    let cur = '';
    try { cur = await readFile(path, 'utf8'); } catch { /* file may not exist yet */ }
    if (/^\/?\.claude\/?$/m.test(cur)) return;
    await appendFile(path, `${!cur || cur.endsWith('\n') ? '' : '\n'}/.claude/\n`);
  } catch { /* best-effort */ }
}

// Merge a hooks block into the worktree's .claude/settings.local.json without
// clobbering existing entries — idempotent (deduped by matcher + command).
async function mergeHooks(worktreePath, template) {
  const settingsPath = join(worktreePath, '.claude', 'settings.local.json');
  let cur = {};
  try { cur = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* new file */ }
  cur.hooks ||= {};
  for (const [event, matchers] of Object.entries(template.hooks || {})) {
    cur.hooks[event] ||= [];
    for (const m of matchers) {
      let block = cur.hooks[event].find((b) => b.matcher === m.matcher);
      if (!block) { block = { matcher: m.matcher, hooks: [] }; cur.hooks[event].push(block); }
      block.hooks ||= [];
      for (const h of (m.hooks || [])) {
        if (!block.hooks.some((x) => x.command === h.command)) block.hooks.push(h);
      }
    }
  }
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(cur, null, 2)}\n`);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Copy a tree without ever clobbering differing content: identical files are
// skipped, a destination that differs is left alone and reported. `written`
// maps destination path → owner id so a conflict can name both sides when both
// writes happen inside one provision run.
export async function copyTree(src, dest, { owner = 'unknown', conflicts = [], written = new Map() } = {}) {
  let entries;
  try { entries = await readdir(src, { withFileTypes: true }); } catch { return { copied: 0 }; }
  await mkdir(dest, { recursive: true });
  let copied = 0;
  for (const e of entries) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isDirectory()) {
      copied += (await copyTree(from, to, { owner, conflicts, written })).copied;
      continue;
    }
    if (!e.isFile()) continue;
    const incoming = await readFile(from);
    let existing = null;
    try { existing = await readFile(to); } catch { /* absent — free to write */ }
    if (existing && sha(existing) !== sha(incoming)) {
      conflicts.push({ path: to, incoming: owner, existing: written.get(to) || 'preexisting' });
      continue;
    }
    if (!existing) {
      await copyFile(from, to);
      copied += 1;
    }
    await chmod(to, (await stat(from)).mode & 0o777);   // hooks must stay executable
    written.set(to, owner);
  }
  return { copied };
}

// Copy selected skills + kits (and optionally the gate hooks) from a pack into
// the worktree's .claude/. Returns what was actually provisioned.
export async function provisionPack({ packsDir, pack, skills = [], kits = [], hooks = false, worktreePath }) {
  if (!safeId(pack)) throw new Error(`invalid pack id: ${pack}`);
  const packDir = join(packsDir, pack);
  const out = { skills: [], kits: [], hooks: false };
  const copyInto = async (kind, ids, destRoot) => {
    if (!ids.length) return;
    await mkdir(destRoot, { recursive: true });
    for (const id of ids) {
      if (!safeId(id)) continue;
      try { await cp(join(packDir, kind, id), join(destRoot, id), { recursive: true, force: true }); out[kind].push(id); }
      catch { /* missing source — skip */ }
    }
  };
  await copyInto('skills', skills, join(worktreePath, '.claude', 'skills'));
  await copyInto('kits', kits, join(worktreePath, '.claude', 'kits'));
  if (hooks) {
    const cat = JSON.parse(await readFile(join(packDir, 'catalog.json'), 'utf8'));
    const h = cat.hooks;
    if (h) {
      const claudeDir = join(worktreePath, '.claude');
      if (h.dir) await cp(join(packDir, h.dir), join(claudeDir, 'hooks'), { recursive: true, force: true });
      if (h.schemas) await cp(join(packDir, h.schemas), join(claudeDir, 'schemas'), { recursive: true, force: true });
      if (h.settings) await mergeHooks(worktreePath, JSON.parse(await readFile(join(packDir, h.settings), 'utf8')));
      out.hooks = true;
    }
  }
  if (out.skills.length || out.kits.length || out.hooks) await ensureHidden(worktreePath);
  return out;
}
