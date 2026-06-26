import { readdir, readFile, mkdir, cp, appendFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';

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

// Copy selected skills + kits from a pack into the worktree's .claude/.
// Returns what was actually provisioned (unknown/unsafe ids are skipped).
export async function provisionPack({ packsDir, pack, skills = [], kits = [], worktreePath }) {
  if (!safeId(pack)) throw new Error(`invalid pack id: ${pack}`);
  const packDir = join(packsDir, pack);
  const out = { skills: [], kits: [] };
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
  if (out.skills.length || out.kits.length) await ensureHidden(worktreePath);
  return out;
}
