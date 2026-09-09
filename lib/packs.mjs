import { readdir, readFile, writeFile, mkdir, copyFile, chmod, stat, appendFile, unlink, symlink, realpath } from 'node:fs/promises';
import { join, isAbsolute, dirname, basename, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveHookFile } from './session-scope.mjs';

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

// The repos a pack auto-provisions into, as forest names them (the repo
// directory's basename — see listRepoDirs / addRepoRecord in discover.mjs).
// Anything that is not an array of non-empty strings reads as "no targets":
// a malformed catalog makes a pack picker-only, never auto-installed.
export function packTargets(cat) {
  const t = cat && cat.targets;
  if (!Array.isArray(t)) return [];
  return t.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

// The automatic selection for a repo: every pack whose targets name it (or
// '*'), with ALL of its skills, kits and its gate set. Produces the exact
// shape the picker sends (see public/app.js startSession), so the provision
// record, the orphan guard and repair work on it unchanged — and because it
// is the whole pack, it is a superset of any earlier record and can never
// orphan a unit.
export function autoSelections(packs, repoName) {
  if (!repoName) return [];
  const out = [];
  for (const cat of packs || []) {
    const targets = packTargets(cat);
    if (!targets.includes('*') && !targets.includes(repoName)) continue;
    if (!safeId(cat.pack)) continue;
    out.push({
      pack: cat.pack,
      skills: (Array.isArray(cat.skillsets) ? cat.skillsets : []).map((s) => s && s.id).filter((id) => safeId(id)),
      kits: (Array.isArray(cat.kits) ? cat.kits : []).map((k) => k && k.id).filter((id) => safeId(id)),
      hooks: Boolean(cat.hooks),
    });
  }
  return out;
}

// What version of a pack is on disk, as one string a provision record can
// carry: the pack directory's git TREE hash, when the pack sits in a git repo
// and has no uncommitted change under it (edits, deletions, or untracked
// files — an untracked new skill counts, so it gets provisioned rather than
// waiting for a commit). Null otherwise, and null always means "provision":
// that is the developer's editing loop, and it must never be served stale.
//
// Cached per pack dir for `ttlMs`: launch, task and the guided notify can
// arrive within the same second for one worktree, and each would otherwise
// fork git three times.
const fingerprintCache = new Map(); // packDir -> { at, value }
export async function packFingerprint(packsDir, pack, { now = Date.now(), ttlMs = 2000 } = {}) {
  if (!packsDir || !safeId(pack)) return null;
  const packDir = join(packsDir, pack);
  const hit = fingerprintCache.get(packDir);
  if (hit && now - hit.at < ttlMs) return hit.value;
  let value = null;
  const top = await git(packDir, ['rev-parse', '--show-toplevel']);
  if (top) {
    const dirty = await git(packDir, ['status', '--porcelain', '--', '.']);
    if (dirty === '') {
      const realTop = await realpath(top).catch(() => top);
      const realPackDir = await realpath(packDir).catch(() => packDir);
      const rel = relative(realTop, realPackDir).split(sep).join('/');
      value = await git(top, ['rev-parse', rel ? `HEAD:${rel}` : 'HEAD^{tree}']);
    }
  }
  fingerprintCache.set(packDir, { at: now, value });
  return value;
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

// The general form of ensureHidden() above, for anything else forest writes
// into a worktree that must not show up in the user's `git status` —
// currently the Cursor-launch ticket briefs (docs/hektor/tickets/*.md, see
// lib/actions.mjs's writeTicketBrief). Checked first via `git check-ignore`
// against `checkPath` (an already-ignored path — via a tracked .gitignore,
// or a PRIOR run of this same call — is left alone, never double-appended);
// `pattern` (a full git-exclude line, e.g. '/docs/hektor/') is appended to
// the worktree's LOCAL exclude only if not already covered. That file
// resolves via `git rev-parse --git-path info/exclude`, which for a LINKED
// worktree is the path SHARED at the common git dir, not a per-worktree
// copy — so in practice this only actually writes once per repo, and every
// other worktree's check-ignore already sees it. Never the tracked
// .gitignore. Best-effort and returns whether exclusion is now believed
// true, but never throws: a failure here must not block whatever wrote the
// file this protects — the caller decides whether that's worth a warning.
//
// Deliberately NOT built by refactoring ensureHidden() to call this: nothing
// currently exercises ensureHidden's own exclude-writing mechanics directly
// enough to safely change what it does under its existing callers, so the
// two stay independent rather than one becoming a thin wrapper on the other.
export async function ensureExcluded(worktreePath, { checkPath, pattern }) {
  try {
    const ignored = await new Promise((res) => execFile('git', ['-C', worktreePath, 'check-ignore', '-q', checkPath], (err) => res(!err)));
    if (ignored) return true;
    const ex = await git(worktreePath, ['rev-parse', '--git-path', 'info/exclude']);
    if (!ex) return false;
    const exPath = isAbsolute(ex) ? ex : join(worktreePath, ex);
    let cur = '';
    try { cur = await readFile(exPath, 'utf8'); } catch { /* file may not exist yet */ }
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^${escaped}$`, 'm').test(cur)) return true;
    await appendFile(exPath, `${!cur || cur.endsWith('\n') ? '' : '\n'}${pattern}\n`);
    return true;
  } catch { return false; }
}

// --- hook dispatcher --------------------------------------------------------
// Registrations never name gate scripts (a named path goes stale the moment a
// script moves, and a live session's config snapshot cannot be repaired from
// disk). Each (event, matcher) registers ONE permanent command — dispatch.sh
// plus a slug — and the scripts are enumerated from .claude/hooks/<slug>.d/
// symlinks at call time. Spec:
// docs/superpowers/specs/2026-08-05-hook-dispatcher-design.md

export function matcherSlug(event, matcher) {
  return !matcher || matcher === '*' ? event : `${event}-${matcher.replace(/[^A-Za-z0-9]+/g, '_')}`;
}

// The entry guard lets a broken symlink through on purpose: it must reach the
// not-executable warning below, not vanish silently — a gate that is wired but
// not running is exactly the state this design exists to make observable.
// realpath before exec keeps $0/BASH_SOURCE pointing at the real script so
// dirname-relative lib loading (commit-gate.sh:35) survives the symlink.
export const DISPATCH_SH = `#!/bin/sh
# dispatch.sh <slug> — run every entry in .claude/hooks/<slug>.d/, name order.
# Registered once per (event, matcher); the .d directory IS the registration
# list. A missing directory means nothing is wired here (an unprovisioned
# tree), which is a fact, not an error. Written by forest; edits are
# overwritten on the next provision.
d="\${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/hooks/\${1:?usage: dispatch.sh <slug>}.d"
[ -d "$d" ] || exit 0
payload="$(cat)"
for h in "$d"/*; do
  [ -e "$h" ] || [ -L "$h" ] || continue
  t="$(realpath "$h" 2>/dev/null || printf '%s' "$h")"
  if [ ! -x "$t" ]; then
    echo "dispatch: $h -> $t is not executable — this gate is wired but not running" >&2
    continue
  fi
  printf '%s' "$payload" | "$t" || exit $?
done
exit 0
`;

// Byte-identical everywhere, rewritten on drift: the dispatcher carries no
// policy, so overwriting it can never lose a gate.
export async function ensureDispatcher(hooksDir) {
  const p = join(hooksDir, 'dispatch.sh');
  await mkdir(hooksDir, { recursive: true });
  let cur = null;
  try { cur = await readFile(p, 'utf8'); } catch { /* absent */ }
  if (cur !== DISPATCH_SH) await writeFile(p, DISPATCH_SH);
  await chmod(p, 0o755);
  return p;
}

const dispatchCommand = (slug) => `"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" ${slug}`;

// Successor to the old mergeHooks: apply a settings fragment by linking each
// file-invoking entry into its <slug>.d directory and registering the
// dispatcher line once, idempotently. Entries that are not file invocations
// (inline shell) are merged verbatim exactly as before. In the same pass any
// per-script registration in the SAME (event, matcher) block whose basename
// was just linked is stripped — that converts a worktree provisioned under
// the old scheme on its next provision or repair. Only the worktree's own
// settings.local.json is ever touched.
export async function registerDispatch(worktreePath, template) {
  const settingsPath = join(worktreePath, '.claude', 'settings.local.json');
  const hooksDir = join(worktreePath, '.claude', 'hooks');
  let cur = {};
  try { cur = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* new file */ }
  cur.hooks ||= {};
  let linkedAny = false;
  for (const [event, matchers] of Object.entries(template.hooks || {})) {
    cur.hooks[event] ||= [];
    for (const m of matchers) {
      const slug = matcherSlug(event, m.matcher);
      const dDir = join(hooksDir, `${slug}.d`);
      const linked = [];
      const verbatim = [];
      let order = 10;
      for (const h of (m.hooks || [])) {
        const file = resolveHookFile(h.command, worktreePath);
        if (!file) { verbatim.push(h); continue; }
        await mkdir(dDir, { recursive: true });
        const link = join(dDir, `${String(order).padStart(2, '0')}-${basename(file)}`);
        order += 10;
        // The .d tree is wholly forest-owned, so replace rather than conflict.
        try { await unlink(link); } catch { /* absent */ }
        await symlink(relative(dDir, file), link);
        linked.push(basename(file));
        linkedAny = true;
      }
      let block = cur.hooks[event].find((b) => b.matcher === m.matcher);
      if (!block) { block = { matcher: m.matcher, hooks: [] }; cur.hooks[event].push(block); }
      block.hooks ||= [];
      if (linked.length) {
        block.hooks = block.hooks.filter((x) => {
          const f = resolveHookFile(x.command, worktreePath);
          return !(f && linked.includes(basename(f)));
        });
        const cmd = dispatchCommand(slug);
        if (!block.hooks.some((x) => x.command === cmd)) {
          block.hooks.push({ type: 'command', command: cmd, timeout: 10 });
        }
      }
      for (const h of verbatim) {
        if (!block.hooks.some((x) => x.command === h.command)) block.hooks.push(h);
      }
    }
  }
  if (linkedAny) await ensureDispatcher(hooksDir);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(cur, null, 2)}\n`);
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Copy a tree without ever clobbering differing content: identical files are
// skipped, a destination that differs is left alone and reported. `written`
// maps destination path → owner id so a conflict can name both sides when both
// writes happen inside one provision run.
//
// `overwrite` is refresh semantics: a destination that differs is UPDATED to
// the source version instead of reported — that is what "refresh this
// worktree" means, and without it a pack source that moves on makes every
// refresh report the same stale-vendor conflicts forever. The one protection
// that survives overwrite is the same-run cross-owner check: two kits writing
// one path in a single provision is a real collision, not staleness.
export async function copyTree(src, dest, { owner = 'unknown', conflicts = [], written = new Map(), overwrite = false, updatedPaths = [] } = {}) {
  let entries;
  try { entries = await readdir(src, { withFileTypes: true }); } catch { return { copied: 0, updated: 0, updatedPaths }; }
  await mkdir(dest, { recursive: true });
  let copied = 0;
  let updated = 0;
  for (const e of entries) {
    const from = join(src, e.name);
    const to = join(dest, e.name);
    if (e.isDirectory()) {
      const r = await copyTree(from, to, { owner, conflicts, written, overwrite, updatedPaths });
      copied += r.copied;
      updated += r.updated;
      continue;
    }
    if (!e.isFile()) continue;
    const incoming = await readFile(from);
    let existing = null;
    try { existing = await readFile(to); } catch { /* absent — free to write */ }
    if (existing && sha(existing) !== sha(incoming)) {
      const other = written.get(to);
      if (!overwrite || (other && other !== owner)) {
        conflicts.push({ path: to, incoming: owner, existing: other || 'preexisting' });
        continue;
      }
      await copyFile(from, to);
      updated += 1;
      updatedPaths.push(to);   // named in the journal: a local edit was just replaced
    }
    if (!existing) {
      await copyFile(from, to);
      copied += 1;
    }
    await chmod(to, (await stat(from)).mode & 0o777);   // hooks must stay executable
    written.set(to, owner);
  }
  return { copied, updated, updatedPaths };
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
export async function provisionKit({ kitDir, kitId, worktreePath, conflicts, written, notes = [], refresh = false, updatedPaths = [] }) {
  const man = await readKitManifest(kitDir);
  const claudeDir = join(worktreePath, '.claude');
  const opts = { owner: kitId, conflicts, written, overwrite: refresh, updatedPaths };
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
    await registerDispatch(worktreePath, JSON.parse(await readFile(join(kitDir, man.settingsFile), 'utf8')));
  } catch { /* kit ships no settings fragment */ }
  return { id: kitId, skills: skillDirs };
}

// Copy selected skills + kits (and optionally the gate hooks) from a pack into
// the worktree's .claude/. Returns what was actually provisioned.
export async function provisionPack({ packsDir, pack, skills = [], kits = [], hooks = false, worktreePath, refresh = false }) {
  if (!safeId(pack)) throw new Error(`invalid pack id: ${pack}`);
  const packDir = join(packsDir, pack);
  const out = { skills: [], kits: [], hooks: false, kitSkills: [], conflicts: [], notes: [], updated: [] };
  const written = new Map();
  const opts = (owner) => ({ owner, conflicts: out.conflicts, written, overwrite: refresh, updatedPaths: out.updated });

  for (const id of skills) {
    if (!safeId(id)) continue;
    const { copied } = await copyTree(join(packDir, 'skills', id), join(worktreePath, '.claude', 'skills', id), opts(id));
    if (copied || await exists(join(packDir, 'skills', id))) out.skills.push(id);
  }
  for (const id of kits) {
    if (!safeId(id)) continue;
    if (!await exists(join(packDir, 'kits', id))) continue;
    const r = await provisionKit({ kitDir: join(packDir, 'kits', id), kitId: id, worktreePath, conflicts: out.conflicts, written, notes: out.notes, refresh, updatedPaths: out.updated });
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
      if (h.settings) await registerDispatch(worktreePath, JSON.parse(await readFile(join(packDir, h.settings), 'utf8')));
      out.hooks = true;
    }
  }
  if (out.skills.length || out.kits.length || out.hooks) {
    await ensureHidden(worktreePath);
    // Unconditionally, not only when registerDispatch linked something: a
    // worktree session inherits its PRIMARY repo's registrations (git common
    // dir), and once the primary registers dispatcher lines, a worktree
    // without dispatch.sh exec-fails on every inherited line. The dispatcher
    // is policy-free — with no .d directories it is a silent no-op.
    await ensureDispatcher(join(worktreePath, '.claude', 'hooks'));
  }
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
//   - a hooks dir that EXISTS but is EMPTY writes nothing either: `copyTree`
//     reads it, finds no entries, and copies nothing. `exists()` alone said
//     `true` here; `hasEntries` below refutes it.
//   - a settings fragment that EXISTS but does not parse as JSON also writes
//     nothing: `provisionKit`'s `JSON.parse` throws and is swallowed (see its
//     own try/catch, a few lines up in this file) before `mergeHooks` ever
//     runs. `exists()` alone said `true` here too; `isParsableJson` refutes it.
//   - `hooks: true` is the pack's own gate set, which forest copies and merges
//     itself; the catalog says whether there is anything to copy or merge.
//
// Plain skills never qualify: a skill is copied into `.claude/skills/<id>/`
// and touches no settings file and no hook script.
const hasEntries = async (p) => { try { return (await readdir(p)).length > 0; } catch { return false; } };
const isParsableJson = async (p) => {
  try { JSON.parse(await readFile(p, 'utf8')); return true; } catch { return false; }
};

export async function writesHookWiring({ packsDir, pack, kits = [], hooks = false }) {
  if (!packsDir || !safeId(pack)) return false;
  const packDir = join(packsDir, pack);
  for (const id of kits) {
    if (!safeId(id)) continue;
    const kitDir = join(packDir, 'kits', id);
    // Mirrors provisionPack's own skip so the two read alike — but it is
    // deliberately NOT the branch that decides the case, and a mutation that
    // deletes it reddens nothing. `readKitManifest` falls back to the
    // conventions for a directory that is not there, so every check below is
    // false anyway and the answer is the same either way. Kept for fidelity
    // and legibility; do not mistake it for load-bearing.
    if (!await exists(kitDir)) continue;
    if (await exists(join(kitDir, 'install.sh'))) return true;  // the kit owns its wiring
    const man = await readKitManifest(kitDir);
    if (await hasEntries(join(kitDir, man.hooksDir))) return true;
    if (await isParsableJson(join(kitDir, man.settingsFile))) return true;
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
// `cursor` — `{ packs, at }` — is the Cursor axis (Task 6's wireCursorAxis):
// which packs had their install.sh --harness cursor run here, and when.
// Written only when given, for the same reason `inventory` is: a record
// that never had one must not start claiming an empty one.
export async function writeProvisionRecord(worktreePath, selections, inventory = null, at = null, cursor = null, extra = null) {
  const file = join(worktreePath, '.claude', PROVISION_FILE);
  await mkdir(dirname(file), { recursive: true });
  const rec = { at: typeof at === 'string' && at ? at : new Date().toISOString(), selections };
  if (inventory) rec.inventory = inventory;
  if (cursor) rec.cursor = cursor;
  // `fingerprints`: the pack tree hashes this record was provisioned from
  // (ensureProvisioned's skip rule reads them). `auto`: whether the selection
  // came from the catalog's targets or from the picker. Written only when
  // given, like `inventory` and `cursor`: a record that never had them must
  // not start claiming empty ones.
  if (extra && typeof extra === 'object') {
    if (extra.fingerprints && typeof extra.fingerprints === 'object') rec.fingerprints = extra.fingerprints;
    if (typeof extra.auto === 'boolean') rec.auto = extra.auto;
  }
  await writeFile(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}

export async function readProvisionRecord(worktreePath) {
  try { return JSON.parse(await readFile(join(worktreePath, '.claude', PROVISION_FILE), 'utf8')); }
  catch { return null; }
}
