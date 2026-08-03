import { readdir, readFile, writeFile, mkdir, copyFile, chmod, stat, appendFile } from 'node:fs/promises';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const PROVISION_FILE = '.forest-provision.json';

// A plain, single path segment: no slashes (the character class already
// forbids them), and — the part the character class alone cannot express —
// not '.' or '..', which are made entirely of accepted characters yet mean
// "this directory" / "this directory's parent" once joined into a path.
export const safeId = (id) => typeof id === 'string' && id !== '.' && id !== '..' && /^[A-Za-z0-9._-]+$/.test(id);
const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

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

const KIT_DEFAULTS = { hooks: 'hooks', schemas: 'schemas', skills: 'skills', settings: 'settings.hooks.json' };

// A kit describes itself by convention; kit.json only carries display metadata
// or an override for a kit that deviates from the layout.
export async function readKitManifest(kitDir) {
  let m = {};
  try { m = JSON.parse(await readFile(join(kitDir, 'kit.json'), 'utf8')); } catch { /* conventions only */ }
  const h = m.hooks || {};
  return {
    id: m.id || basename(kitDir),
    label: m.label || basename(kitDir),
    description: m.description || '',
    hooksDir: h.dir || KIT_DEFAULTS.hooks,
    schemasDir: h.schemas || KIT_DEFAULTS.schemas,
    settingsFile: h.settings || KIT_DEFAULTS.settings,
    skillsDir: (m.skills && m.skills.dir) || KIT_DEFAULTS.skills,
  };
}

const skillDirNames = async (claudeDir) => {
  try {
    return (await readdir(join(claudeDir, 'skills'), { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
};

const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

// Run a kit's own installer. Resolves with its exit code rather than throwing:
// a refusal and a crash are different facts and both need reporting.
function runKitInstaller(installer, worktreePath) {
  return new Promise((resolve) => {
    execFile(
      installer,
      ['--harness', 'claude', '--project', worktreePath],
      { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || ''),
      }),
    );
  });
}

// Provision one kit into a worktree: the kit tree itself under .claude/kits/,
// plus whatever it declares — hooks/, schemas/, skills/*, settings fragment.
//
// A kit that ships install.sh is the authority on its own wiring, so we run it
// instead of guessing from the conventions. The installer does work a file copy
// cannot express: detecting a JDK and writing it into the kit's config, filling
// in source roots, relocating a registration left by an older layout, refusing
// to overwrite a root-owned (hardened) install, and registering its gate with
// the harness under $CLAUDE_PROJECT_DIR.
//
// Guessing produced the failure this exists to prevent: a kit whose layout
// matches none of the four conventions is copied into .claude/kits/, every
// other step silently finds nothing, and the provision record reports the kit
// as provisioned. The worktree then holds the kit with none of it wired and
// says nothing about why. Observed twice in web-test worktrees.
export async function provisionKit({ kitDir, kitId, worktreePath, conflicts, written, notes = [] }) {
  const man = await readKitManifest(kitDir);
  const claudeDir = join(worktreePath, '.claude');
  const opts = { owner: kitId, conflicts, written };
  await copyTree(kitDir, join(claudeDir, 'kits', kitId), opts);

  const installer = join(kitDir, 'install.sh');
  if (await exists(installer)) {
    const before = await skillDirNames(claudeDir);
    const r = await runKitInstaller(installer, worktreePath);
    const skills = (await skillDirNames(claudeDir)).filter((n) => !before.includes(n));
    if (r.code === 0) {
      notes.push(`${kitId}: wired by its own install.sh${skills.length ? ` (skills: ${skills.join(', ')})` : ''}`);
    } else if (r.code === 75) {
      // The installer's refusal to overwrite a root-owned tree is the kit's
      // protection working, not a provisioning failure. Say so in those words.
      notes.push(`${kitId}: install refused — an existing install is root-owned (hardened). Unlock and reinstall to upgrade it.`);
    } else {
      notes.push(`${kitId}: install.sh FAILED (exit ${r.code}) — the kit is copied but NOT wired. ${lastLine(r.err) || lastLine(r.out)}`);
    }
    return { id: kitId, skills };
  }
  await copyTree(join(kitDir, man.hooksDir), join(claudeDir, 'hooks'), opts);
  await copyTree(join(kitDir, man.schemasDir), join(claudeDir, 'schemas'), opts);
  let skillDirs = [];
  try {
    skillDirs = (await readdir(join(kitDir, man.skillsDir), { withFileTypes: true }))
      .filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* kit ships no skills */ }
  for (const name of skillDirs) {
    await copyTree(join(kitDir, man.skillsDir, name), join(claudeDir, 'skills', name), opts);
  }
  try {
    await mergeHooks(worktreePath, JSON.parse(await readFile(join(kitDir, man.settingsFile), 'utf8')));
  } catch { /* kit ships no settings fragment */ }
  return { id: kitId, skills: skillDirs };
}

// Copy selected skills + kits (and optionally the gate hooks) from a pack into
// the worktree's .claude/. Returns what was actually provisioned.
export async function provisionPack({ packsDir, pack, skills = [], kits = [], hooks = false, worktreePath }) {
  if (!safeId(pack)) throw new Error(`invalid pack id: ${pack}`);
  const packDir = join(packsDir, pack);
  const out = { skills: [], kits: [], hooks: false, kitSkills: [], conflicts: [], notes: [] };
  const written = new Map();
  const opts = (owner) => ({ owner, conflicts: out.conflicts, written });

  for (const id of skills) {
    if (!safeId(id)) continue;
    const { copied } = await copyTree(join(packDir, 'skills', id), join(worktreePath, '.claude', 'skills', id), opts(id));
    if (copied || await exists(join(packDir, 'skills', id))) out.skills.push(id);
  }
  for (const id of kits) {
    if (!safeId(id)) continue;
    if (!await exists(join(packDir, 'kits', id))) continue;
    const r = await provisionKit({ kitDir: join(packDir, 'kits', id), kitId: id, worktreePath, conflicts: out.conflicts, written, notes: out.notes });
    out.kits.push(id);
    out.kitSkills.push(...r.skills);
  }
  if (hooks) {
    const cat = JSON.parse(await readFile(join(packDir, 'catalog.json'), 'utf8'));
    const h = cat.hooks;
    if (h) {
      const claudeDir = join(worktreePath, '.claude');
      const o = opts(h.id || `${pack}-gates`);
      if (h.dir) await copyTree(join(packDir, h.dir), join(claudeDir, 'hooks'), o);
      if (h.schemas) await copyTree(join(packDir, h.schemas), join(claudeDir, 'schemas'), o);
      if (h.settings) await mergeHooks(worktreePath, JSON.parse(await readFile(join(packDir, h.settings), 'utf8')));
      out.hooks = true;
    }
  }
  if (out.skills.length || out.kits.length || out.hooks) await ensureHidden(worktreePath);
  return out;
}

// Would provisioning this selection write any hook wiring — a script under
// `.claude/hooks/` (what a registration points at) or a settings fragment
// merged into `.claude/settings.local.json` (the registration itself)?
//
// This is what decides whether `/api/worktree/repair`, which replays a
// record's selections through `provisionPack` and does nothing else, can move
// a registered-but-missing hook. It asks the pack source with the same calls
// `provisionPack`/`provisionKit` make, in the same order, so the answer cannot
// drift from what a replay would actually do:
//
//   - a kit the pack no longer ships is SKIPPED outright — `provisionPack`'s
//     own `exists(packDir/kits/<id>)` guard, a few lines up — so replaying it
//     writes nothing at all. One `exists()` settles that; it is not
//     conservatism about an unknown, it is an already-decided question.
//   - a kit that ships `install.sh` owns its own wiring, and forest cannot
//     predict which files that installer touches. This is the one honest
//     "maybe" left, and it is deliberately answered `true`.
//   - otherwise the conventions decide, exactly as `provisionKit` applies
//     them: a hooks dir to copy, or a settings fragment to merge. A kit that
//     ships neither — only `kit.json`, or only skills — is copied into
//     `.claude/kits/<id>/` and writes no wiring. Refuted.
//   - `hooks: true` is the pack's own gate set, which forest copies and merges
//     itself; the catalog says whether there is anything to copy or merge.
//
// Plain skills never qualify: a skill is copied into `.claude/skills/<id>/`
// and touches no settings file and no hook script.
export async function writesHookWiring({ packsDir, pack, kits = [], hooks = false }) {
  if (!packsDir || !safeId(pack)) return false;
  const packDir = join(packsDir, pack);
  for (const id of kits) {
    if (!safeId(id)) continue;
    const kitDir = join(packDir, 'kits', id);
    if (!await exists(kitDir)) continue;                        // provisionPack skips it
    if (await exists(join(kitDir, 'install.sh'))) return true;  // the kit owns its wiring
    const man = await readKitManifest(kitDir);
    if (await exists(join(kitDir, man.hooksDir))) return true;
    if (await exists(join(kitDir, man.settingsFile))) return true;
  }
  if (hooks) {
    try {
      const h = JSON.parse(await readFile(join(packDir, 'catalog.json'), 'utf8')).hooks;
      if (h && (h.dir || h.settings)) return true;
    } catch { /* no catalog, or none that declares a gate set */ }
  }
  return false;
}

// `selections` is what the user asked for. `inventory` is what provisioning
// actually produced — they diverge the moment a unit is deselected, and the
// launch guard needs the second one to notice a unit left behind.
//
// `at` defaults to now, which is right for a provision — it is when these
// units were written. A caller that is only TRIMMING the record (removing a
// unit) passes the record's own `at` through instead: the surviving units were
// not re-provisioned, and letting their `since` read as the removal date makes
// an orphan look newer, and so safer, than it is — in the dialog that gates an
// irreversible action.
export async function writeProvisionRecord(worktreePath, selections, inventory = null, at = null) {
  const file = join(worktreePath, '.claude', PROVISION_FILE);
  await mkdir(dirname(file), { recursive: true });
  const rec = { at: typeof at === 'string' && at ? at : new Date().toISOString(), selections };
  if (inventory) rec.inventory = inventory;
  await writeFile(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}

export async function readProvisionRecord(worktreePath) {
  try { return JSON.parse(await readFile(join(worktreePath, '.claude', PROVISION_FILE), 'utf8')); }
  catch { return null; }
}
