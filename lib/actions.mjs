import { mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runGit, extractTicket } from './git.mjs';
import { runInTerminal, openWith } from './terminal.mjs';
import { launchInteractive, runHeadless } from './agents.mjs';
import { provisionPack, writeProvisionRecord, readProvisionRecord, safeId } from './packs.mjs';
import { previewFinish, executeFinish, executeEject, finishCommands, slug } from './finish.mjs';
import { readLandings } from './landed.mjs';
import { worktreePathFor } from './config.mjs';
import { resolveSessionScope } from './session-scope.mjs';
import { addRepo, removeRepo, repoErrorMessage } from './repos.mjs';
import { selectCandidates, pruneCommands, pruneWorktrees, dirSizeBytes } from './prune.mjs';

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Human label for a worktree path, used as the Terminal tab title at launch:
// Layout-independent: the last segment is always the branch slug (or repo name for primary),
// and we extract the ticket from it. Works with any worktreeRoot configuration.
export function worktreeTitle(p) {
  const parts = String(p).split('/').filter(Boolean);
  const last = parts[parts.length - 1] || String(p);
  return extractTicket(last) || last;
}

// Can `/api/worktree/repair` actually fix a registered-but-missing hook?
//
// Repair replays `rec.selections` through `runSelections` and does nothing
// else, so it can only rewrite a registration when the record still names
// something that writes one:
//   - a kit — its own install.sh owns its wiring and re-running it is exactly
//     what rewrites the registration (lib/packs.mjs:176-190). Forest cannot
//     predict which files that installer touches, so a recorded kit means
//     "possible", not "certain".
//   - `hooks: true` — the pack's own gate set, which forest copies into
//     .claude/hooks/ and merges into settings.local.json itself.
// A record naming only plain skills provably cannot: a skill is copied into
// .claude/skills/<id>/ and nothing else — no settings file, no hook script.
//
// That last case is the state Remove leaves behind. The removed kit is gone
// from the record (see the remove route), so the installer that owns the
// dangling registration never runs again, and the old meaning of this flag —
// "a non-empty selections list exists" — offered a Repair that provably could
// not work, forever. The remedy there is to re-select the unit and launch,
// which is a superset of what repair does; nothing is lost by refusing here.
export function repairableRecord(record) {
  const sels = Array.isArray(record?.selections) ? record.selections : [];
  return sels.some((s) => s && typeof s === 'object'
    && (!!s.hooks || (Array.isArray(s.kits) && s.kits.length > 0)));
}

// Whether a launch may proceed. Injectable dependencies so the decision is
// testable without opening a Terminal window.
// A failure to resolve scope deliberately allows the launch: this guard exists
// to warn about missing gates, and must never become the reason forest cannot
// start a session.
export async function launchDecision({ path, force = false, resolveScope = resolveSessionScope, readRecord = readProvisionRecord }) {
  if (force) return { launch: true };
  let scope;
  try { scope = await resolveScope(path); } catch { return { launch: true }; }
  if (!scope?.missing?.length) return { launch: true };
  const record = await readRecord(path).catch(() => null);
  return {
    launch: false,
    blocked: 'missing-hooks',
    missing: scope.missing.map((h) => ({ command: h.command, source: h.source })),
    repairable: repairableRecord(record),
  };
}

// Units the previous provision wrote that the incoming selection no longer
// names. Provisioning is additive, so a deselected unit stays on disk,
// registered and running, at whatever version it had — and because the launch
// route overwrites the record with the new selection, it also stops being
// visible to `/api/worktree/repair`, which re-provisions from `rec.selections`.
//
// Pure and synchronous on purpose: it compares two records and touches nothing.
// `launchDecision` answers a different question from different inputs (the
// worktree's current disk state), so the two stay separate.
export function orphanedUnits(previousRecord, selections = []) {
  const inv = previousRecord?.inventory;
  if (!inv) return [];
  const picked = (key) => new Set(selections.flatMap((s) => s?.[key] || []));
  const out = [];
  for (const [key, kind] of [['kits', 'kit'], ['skills', 'skill']]) {
    const still = picked(key);
    for (const id of inv[key] || []) {
      if (!still.has(id)) out.push({ kind, id, since: previousRecord.at });
    }
  }
  return out;
}

// The record as it must read once `units` are no longer on disk. Pure, and
// returns the two arguments `writeProvisionRecord` takes.
//
// Both halves have to drop the id or a removal is a one-way door:
//   - `inventory` — the orphan guard compares it against the incoming
//     selection, so leaving the id there re-blocks the next launch on a unit
//     that no longer exists, with Remove as the only offered remedy and
//     nothing left to remove.
//   - `selections` — `/api/worktree/repair` replays them, so leaving the id
//     there means the next repair silently reinstalls what the user just
//     asked to delete.
// A selection left naming nothing is dropped: it is exactly what /api/launch's
// own filter does with one, and repair refuses an empty list rather than
// replaying a no-op.
//
// `at` is not preserved — writeProvisionRecord stamps a fresh one, so the
// surviving units' `since` reads as the removal time rather than their
// original provision. A second writer for the same file, kept in sync by
// hand, is the worse trade.
export function recordWithout(record, units = []) {
  const gone = (kind) => new Set(units.filter((u) => u && u.kind === kind).map((u) => u.id));
  const kits = gone('kit'), skills = gone('skill');
  const keep = (arr, drop) => (Array.isArray(arr) ? arr : []).filter((id) => !drop.has(id));
  const selections = (Array.isArray(record?.selections) ? record.selections : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      ...s,
      ...(Array.isArray(s.kits) ? { kits: keep(s.kits, kits) } : {}),
      ...(Array.isArray(s.skills) ? { skills: keep(s.skills, skills) } : {}),
    }))
    .filter((s) => s.kits?.length || s.skills?.length || s.hooks);
  const inv = record?.inventory;
  return {
    selections,
    // A record written before the inventory existed stays without one:
    // inventing an empty inventory here would claim provisioning produced
    // nothing, which is a different (and false) statement.
    inventory: inv ? { ...inv, kits: keep(inv.kits, kits), skills: keep(inv.skills, skills) } : null,
  };
}

// Shared by /api/launch and /api/worktree/repair — both provision a list of
// pack selections and must journal any conflict identically. Previously each
// route ran its own copy of this loop and repair's copy silently dropped
// conflicts instead of journalling them (a repair that hit a hash conflict
// kept the old file, returned ok: true, and reported the same counts as
// before with no explanation).
export async function runSelections({ ctx, path, selections, mode }) {
  const out = { skills: [], kits: [], hooks: false, conflicts: [], notes: [] };
  for (const s of selections) {
    const r = await provisionPack({ packsDir: ctx.config.packsDir, pack: s.pack, skills: s.skills || [], kits: s.kits || [], hooks: !!s.hooks, worktreePath: path });
    out.skills.push(...r.skills);
    out.kits.push(...r.kits);
    out.conflicts.push(...r.conflicts);
    out.notes.push(...(r.notes || []));
    if (r.hooks) out.hooks = true;
  }
  for (const c of out.conflicts) {
    ctx.journal.add({ cmd: `collision: ${c.path} (${c.incoming} ≠ ${c.existing}) — kept existing`, cwd: path, mode });
  }
  // A kit that ran its own installer reports the outcome here, including a
  // failure. Provisioning that copies a kit and cannot wire it has to say so:
  // a silent success is exactly what left a worktree holding an inert kit.
  for (const n of out.notes) ctx.journal.add({ cmd: n, cwd: path, mode });
  return out;
}

// `launch` is injectable so the ordering in /api/launch can be tested without
// opening a real Terminal window. `resolveScope` is injectable so the
// missing-hooks guard can be tested without merging the real machine's
// ~/.claude/settings.json into the result.
export function createActionHandler({ launch = launchInteractive, resolveScope = resolveSessionScope } = {}) {
  function sendJson(res, obj, code = 200) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  // Run a git command either in the terminal (guided) or in-process (auto).
  async function dispatchGit({ cwd, args, mode, ctx }) {
    const command = `git ${args.map(shQuote).join(' ')}`;
    ctx.journal.add({ cmd: command, cwd, mode });
    if (mode === 'guided') {
      runInTerminal({ command, cwd, app: ctx.config.terminalApp });
      return { mode, command };
    }
    const out = await runGit(cwd, args);
    ctx.broadcast('worktrees', await ctx.snapshot());
    return { mode, command, output: out };
  }

  return async function handleAction(req, res, ctx, readBody) {
    const url = req.url.split('?')[0];
    const body = await readBody(req);
    const mode = body.mode ?? ctx.config.defaultMode;

    try {
      if (url === '/api/worktree/create') {
        const { repoPath, branch, base, newBranch } = body;
        const wtPath = worktreePathFor({
          worktreeRoot: ctx.config.worktreeRoot,
          repoPath,
          branchSlug: slug(branch),
        });
        await mkdir(dirname(wtPath), { recursive: true });
        const args = newBranch
          ? ['worktree', 'add', '-b', branch, wtPath, base || 'HEAD']
          : ['worktree', 'add', wtPath, branch];
        return sendJson(res, await dispatchGit({ cwd: repoPath, args, mode, ctx }));
      }

      if (url === '/api/worktree/remove') {
        const { repoPath, path, force, isPrimary } = body;
        if (isPrimary) return sendJson(res, { error: 'refusing to remove primary worktree' }, 400);
        const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
        return sendJson(res, await dispatchGit({ cwd: repoPath, args, mode, ctx }));
      }

      if (url === '/api/worktree/apply-diff') {
        const { sourcePath, targetPath } = body;
        if (!sourcePath || !targetPath || sourcePath === targetPath) {
          return sendJson(res, { error: 'pick a different target worktree' }, 400);
        }
        const cmd = `git -C ${shQuote(sourcePath)} diff HEAD | git -C ${shQuote(targetPath)} apply --3way`;
        ctx.journal.add({ cmd, cwd: targetPath, mode });
        if (mode === 'guided') {
          runInTerminal({ command: cmd, cwd: targetPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command: cmd });
        }
        const patch = await runGit(sourcePath, ['diff', 'HEAD']);
        if (!patch.trim()) return sendJson(res, { error: 'no uncommitted (tracked) changes to move' }, 400);
        const tmp = join(tmpdir(), `forest-patch-${Date.now()}.patch`);
        await writeFile(tmp, patch);
        try {
          const out = await runGit(targetPath, ['apply', '--3way', tmp]);
          ctx.broadcast('worktrees', await ctx.snapshot());
          return sendJson(res, { mode, command: cmd, output: out || 'applied' });
        } finally {
          await unlink(tmp).catch(() => {});
        }
      }

      if (url === '/api/worktree/finish-preview') {
        const { repoPath, path } = body;
        return sendJson(res, await previewFinish({ repoPath, path }));
      }

      if (url === '/api/worktree/finish') {
        const { repoPath, path, targetBranch, remove = true, isPrimary } = body;
        if (isPrimary) return sendJson(res, { error: 'refusing to finish the primary worktree' }, 400);
        if (mode === 'guided') {
          const preview = await previewFinish({ repoPath, path });
          const tb = targetBranch || preview.targetBranch;
          if (!tb) return sendJson(res, { error: `cannot resolve a target branch for ${preview.worktreeName}` }, 400);
          const command = finishCommands({ repoPath, path, targetBranch: tb, remove, preview }).join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        const result = await executeFinish({
          repoPath, path, targetBranch, remove,
          onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }

      if (url === '/api/worktree/eject') {
        const { repoPath } = body;
        if (mode === 'guided') {
          const entries = await readLandings(repoPath);
          const entry = entries[entries.length - 1];
          if (!entry) return sendJson(res, { error: 'nothing to eject — no recorded landing' }, 400);
          if (!entry.previousBranch) return sendJson(res, { error: 'recorded landing has no previous branch (primary was detached at finish time)' }, 400);
          const command = [
            `git -C ${shQuote(repoPath)} switch ${shQuote(entry.previousBranch)}`,
            `git -C ${shQuote(repoPath)} worktree add ${shQuote(entry.path)} ${shQuote(entry.branch)}`,
          ].join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        const result = await executeEject({
          repoPath, onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }

      if (url === '/api/worktree/scope') {
        const { path } = body;
        const s = await resolveSessionScope(path);
        return sendJson(res, {
          active: s.active.length,
          inline: s.inline.length,
          sources: s.sources,
          missing: s.missing.map((h) => ({ command: h.command, source: h.source, file: h.file })),
        });
      }

      if (url === '/api/worktree/repair') {
        const { path } = body;
        const rec = await readProvisionRecord(path);
        if (!rec || !Array.isArray(rec.selections) || !rec.selections.length) {
          return sendJson(res, { error: 'no provision record' }, 409);
        }
        const provisioned = await runSelections({ ctx, path, selections: rec.selections, mode });
        const scope = await resolveSessionScope(path);
        ctx.journal.add({ cmd: `repair: re-provisioned ${provisioned.kits.length} kit(s); missing ${scope.missing.length}`, cwd: path, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, provisioned, scope: { active: scope.active.length, missing: scope.missing.length } });
      }

      if (url === '/api/worktree/remove-units') {
        const { path, units = [] } = body;
        const removed = [], refused = [], gone = [];
        for (const u of units) {
          const kind = u && typeof u === 'object' ? u.kind : undefined;
          const id = u && typeof u === 'object' ? u.id : undefined;
          // A bad kind, a bad id, or a unit that isn't even an object all mean
          // the same thing to the caller: nothing happened. Say so — silently
          // dropping it left the caller with no signal at all.
          if (!u || typeof u !== 'object' || (kind !== 'kit' && kind !== 'skill') || !safeId(id)) {
            refused.push({ id: id !== undefined ? String(id) : String(u), reason: 'invalid unit' });
            continue;
          }
          const base = resolve(join(path, '.claude', kind === 'kit' ? 'kits' : 'skills'));
          const dir = resolve(join(base, id));
          // Belt and braces: safeId already forbids '/', '.' and '..', so dir
          // should always land one level under base. Require it explicitly
          // anyway — this delete must not depend solely on a helper shared
          // with three other, non-destructive call sites.
          if (dirname(dir) !== base) {
            refused.push({ id, reason: 'invalid unit' });
            continue;
          }
          try {
            await rm(dir, { recursive: true, force: false });
            removed.push(`${kind}:${id}`);
            gone.push({ kind, id });
            ctx.journal.add({ cmd: `removed ${kind} ${id} from .claude/`, cwd: path, mode });
          } catch (e) {
            // A hardened kit is root-owned; deleting it needs the password the
            // user holds. The kit's own installer says this in these words.
            refused.push({ id, reason: e.code === 'EPERM' || e.code === 'EACCES'
              ? `${id} is root-owned (hardened) — unlock it first, this changes nothing`
              : String(e.message || e) });
          }
        }
        // The record is what the next launch compares against and what repair
        // replays. Leaving it naming a unit that is no longer on disk is what
        // made Remove a one-way door: the guard re-blocked on the removed unit
        // forever, offering a removal with nothing left to remove.
        if (gone.length) {
          try {
            const rec = await readProvisionRecord(path);
            if (rec) {
              const next = recordWithout(rec, gone);
              await writeProvisionRecord(path, next.selections, next.inventory);
              ctx.journal.add({ cmd: `provision record no longer lists ${gone.map((g) => `${g.kind} ${g.id}`).join(', ')}`, cwd: path, mode });
            }
          } catch (e) {
            // Best-effort by necessity: the files are already gone, and
            // answering "remove failed" here would be a lie. Say it loudly
            // where it can be read instead of swallowing it.
            ctx.journal.add({ cmd: `WARNING: could not update the provision record after removal — the next launch will still block on ${gone.map((g) => g.id).join(', ')} (${e.message || e})`, cwd: path, mode });
          }
        }
        return sendJson(res, { ok: true, removed, refused });
      }

      if (url === '/api/git') {
        const { path, action, message } = body;
        const map = { fetch: ['fetch'], pull: ['pull'], push: ['push'], commit: ['commit', '-am', message || 'wip'] };
        const args = map[action];
        if (!args) return sendJson(res, { error: 'unknown git action' }, 400);
        return sendJson(res, await dispatchGit({ cwd: path, args, mode, ctx }));
      }

      if (url === '/api/fetch-all') {
        const snap = await ctx.snapshot();
        const repoPaths = snap.repos.map((r) => r.repoPath);
        const command = repoPaths.map((p) => `git -C ${shQuote(p)} fetch`).join('; ');
        ctx.journal.add({ cmd: command, mode });
        if (mode === 'guided') {
          runInTerminal({ command, cwd: ctx.config.roots[0], app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }
        for (const p of repoPaths) { try { await runGit(p, ['fetch']); } catch { /* skip */ } }
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, command });
      }

      if (url === '/api/repos/add') {
        const { path } = body;
        const r = await addRepo(ctx.forestRoot, path);
        if (!r.ok) return sendJson(res, { error: repoErrorMessage(r.reason, r) }, 400);
        ctx.setRepoList(r.repos);
        ctx.journal.add({ cmd: `repo added: ${path}`, cwd: ctx.forestRoot, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, repos: r.repos });
      }

      if (url === '/api/repos/remove') {
        const { path } = body;
        const r = await removeRepo(ctx.forestRoot, path);
        if (!r.ok) return sendJson(res, { error: repoErrorMessage(r.reason) }, 400);
        ctx.setRepoList(r.repos);
        ctx.journal.add({ cmd: `repo removed from the list (nothing deleted): ${path}`, cwd: ctx.forestRoot, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { ok: true, repos: r.repos });
      }

      if (url === '/api/repo/prune-preview') {
        const { repoPath } = body;
        // Read-only: the cached snapshot is enough, and a fresh build costs
        // seconds. /api/repo/prune below re-reads a FRESH one before deleting,
        // so a stale preview cannot turn into a wrong deletion.
        const snap = await (ctx.cachedSnapshot ?? ctx.snapshot)();
        const repo = snap.repos.find((r) => r.repoPath === repoPath);
        if (!repo) return sendJson(res, { error: 'unknown repo' }, 404);
        const { candidates, kept } = selectCandidates(repo.worktrees, { staleDays: ctx.config.staleDays });
        const withSizes = await Promise.all(candidates.map(async (w) => ({
          path: w.path,
          branch: w.branch,
          detached: w.detached,
          ageDays: w.ageDays,
          sizeBytes: await dirSizeBytes(w.path),
        })));
        return sendJson(res, { candidates: withSizes, kept });
      }

      if (url === '/api/repo/prune') {
        const { repoPath, paths = [] } = body;
        if (!paths.length) return sendJson(res, { error: 'nothing selected' }, 400);
        const snap = await ctx.snapshot();
        const repo = snap.repos.find((r) => r.repoPath === repoPath);
        if (!repo) return sendJson(res, { error: 'unknown repo' }, 404);
        const staleDays = ctx.config.staleDays;

        if (mode === 'guided') {
          // Re-select from the fresh snapshot so the terminal never gets a
          // command for something that stopped qualifying.
          const { candidates } = selectCandidates(repo.worktrees, { staleDays });
          const targets = candidates.filter((w) => paths.includes(w.path));
          if (!targets.length) return sendJson(res, { error: 'nothing left to prune' }, 400);
          const command = pruneCommands({ repoPath, targets }).join(' && ');
          ctx.journal.add({ cmd: command, cwd: repoPath, mode });
          runInTerminal({ command, cwd: repoPath, app: ctx.config.terminalApp });
          return sendJson(res, { mode, command });
        }

        const result = await pruneWorktrees({
          repoPath, paths, worktrees: repo.worktrees, staleDays,
          onStep: (s) => ctx.journal.add({ cmd: s.cmd, cwd: s.cwd, mode }),
        });
        for (const f of result.failed) ctx.journal.add({ cmd: `prune failed (${f.step}): ${f.path} — ${f.error}`, cwd: repoPath, mode });
        for (const s of result.skipped) ctx.journal.add({ cmd: `prune skipped: ${s.path} (${s.reason})`, cwd: repoPath, mode });
        ctx.broadcast('worktrees', await ctx.snapshot());
        return sendJson(res, { mode, ...result });
      }

      if (url === '/api/launch') {
        const { path, selections = [] } = body;
        const sel = selections.filter((s) => s && s.pack && ((s.skills?.length) || (s.kits?.length) || s.hooks));

        // Read AND enforce before provisioning touches anything: a blocked
        // call must mutate nothing — no disk, no record — so a retry with the
        // identical selection blocks identically instead of silently
        // launching one call later. (Reading late enough to compare against
        // an already-rewritten record was Task 3's original bug; returning
        // late enough for that same rewrite to happen anyway, even while
        // blocking, was the same bug one step over.) missing-hooks cannot be
        // checked here — provisioning may be what installs the gate — so it
        // no longer outranks orphaned-units: a missing gate is only knowable
        // after provisioning runs, and provisioning must not run while an
        // orphan is unresolved. A user who hits both sees orphaned-units
        // first, resolves it, and meets missing-hooks on the next launch.
        const previous = await readProvisionRecord(path).catch(() => null);
        const orphaned = orphanedUnits(previous, sel);
        if (orphaned.length && !body.force) {
          const names = orphaned.map((o) => o.id).join(', ');
          ctx.journal.add({ cmd: `launch blocked: ${orphaned.length} provisioned unit(s) no longer selected (${names})`, cwd: path, mode });
          return sendJson(res, {
            ok: false, blocked: 'orphaned-units', orphaned,
            // Constant, and provably so: /api/worktree/repair replays
            // `rec.selections` and never touches the incoming selection — which
            // is the half of the comparison that makes these units orphans. A
            // repair run therefore leaves this block exactly where it stands,
            // however full the record is. `repairableRecord` is not consulted
            // because the question it answers ("can repair rewrite a missing
            // registration?") is not the question here.
            repairable: false,
          });
        }

        let provisioned = null;
        if (sel.length) {
          try {
            provisioned = await runSelections({ ctx, path, selections: sel, mode });
            await writeProvisionRecord(path, sel, { kits: provisioned.kits, skills: provisioned.skills });
            const n = provisioned.skills.length, k = provisioned.kits.length;
            ctx.journal.add({ cmd: `provision: ${n} skill(s)${k ? `, ${k} kit(s)` : ''}${provisioned.hooks ? ', gates' : ''} → .claude/`, cwd: path, mode });
          } catch (e) {
            return sendJson(res, { error: `provision failed: ${e}` }, 500);
          }
        }
        // Check BEFORE opening a terminal: a session loads its hook config at
        // start, so a worktree whose gates are missing produces a session that
        // silently runs ungated. Warning after the launch (which is what this
        // did) is too late to act on. Checked AFTER provisioning (unlike the
        // orphan check above) because provisioning may be what installs the
        // gate that would otherwise report as missing.
        const decision = await launchDecision({ path, force: !!body.force, resolveScope });
        if (!decision.launch) {
          ctx.journal.add({ cmd: `launch blocked: ${decision.missing.length} hook script(s) registered but missing`, cwd: path, mode });
          return sendJson(res, { ok: false, ...decision, provisioned });
        }

        ctx.journal.add({ cmd: 'claude', cwd: path, mode: 'guided' });
        const r = await launch({ worktreePath: path, app: ctx.config.terminalApp, title: worktreeTitle(path) });
        // The injected resolver, like `launchDecision` eight lines up: calling
        // the module-level one here made a route test read (and depend on) the
        // developer's real ~/.claude/settings.json.
        const scope = await resolveScope(path);
        if (scope.missing.length) {
          ctx.journal.add({ cmd: `scope: ${scope.missing.length} hook script(s) registered but missing`, cwd: path, mode });
        }
        return r && r.ok
          ? sendJson(res, { ok: true, action: r.action, provisioned, scope: { active: scope.active.length, missing: scope.missing.map((h) => ({ command: h.command, source: h.source })) } })
          : sendJson(res, { error: (r && r.error) || 'failed to open Terminal' }, 500);
      }

      if (url === '/api/open') {
        const { path, target } = body;
        ctx.journal.add({ cmd: `open ${shQuote(path)} (${target})`, cwd: path, mode: 'guided' });
        openWith({ path, target, openEditorCmd: ctx.config.openEditorCmd, app: ctx.config.terminalApp });
        return sendJson(res, { ok: true });
      }

      if (url === '/api/task') {
        const { path, prompt } = body;
        if (mode === 'guided') {
          // Stay fluent: open a terminal so the user runs claude themselves.
          ctx.journal.add({ cmd: 'claude', cwd: path, mode: 'guided' });
          launch({ worktreePath: path, app: ctx.config.terminalApp, title: worktreeTitle(path) });
          return sendJson(res, { mode: 'guided' });
        }
        ctx.journal.add({ cmd: `claude -p ${shQuote(prompt)}`, cwd: path, mode: 'auto' });
        runHeadless({
          worktreePath: path, prompt, registry: ctx.registry,
          onOutput: (chunk) => ctx.broadcast('task', { path, chunk }),
          onDone: (code) => ctx.broadcast('task', { path, done: true, code }),
        });
        return sendJson(res, { mode: 'auto', started: true });
      }

      return sendJson(res, { error: 'unknown action' }, 404);
    } catch (e) {
      return sendJson(res, { error: String(e) }, 500);
    }
  };
}
