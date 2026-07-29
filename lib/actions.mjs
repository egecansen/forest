import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGit, extractTicket } from './git.mjs';
import { runInTerminal, openWith } from './terminal.mjs';
import { launchInteractive, runHeadless } from './agents.mjs';
import { provisionPack, writeProvisionRecord, readProvisionRecord } from './packs.mjs';
import { previewFinish, executeFinish, executeEject, finishCommands, slug } from './finish.mjs';
import { readLandings } from './landed.mjs';
import { worktreePathFor } from './config.mjs';
import { resolveSessionScope } from './session-scope.mjs';

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// Human label for a worktree path, used as the Terminal tab title at launch:
// Layout-independent: the last segment is always the branch slug (or repo name for primary),
// and we extract the ticket from it. Works with any worktreeRoot configuration.
export function worktreeTitle(p) {
  const parts = String(p).split('/').filter(Boolean);
  const last = parts[parts.length - 1] || String(p);
  return extractTicket(last) || last;
}

// Shared by /api/launch and /api/worktree/repair — both provision a list of
// pack selections and must journal any conflict identically. Previously each
// route ran its own copy of this loop and repair's copy silently dropped
// conflicts instead of journalling them (a repair that hit a hash conflict
// kept the old file, returned ok: true, and reported the same counts as
// before with no explanation).
export async function runSelections({ ctx, path, selections, mode }) {
  const out = { skills: [], kits: [], hooks: false, conflicts: [] };
  for (const s of selections) {
    const r = await provisionPack({ packsDir: ctx.config.packsDir, pack: s.pack, skills: s.skills || [], kits: s.kits || [], hooks: !!s.hooks, worktreePath: path });
    out.skills.push(...r.skills);
    out.kits.push(...r.kits);
    out.conflicts.push(...r.conflicts);
    if (r.hooks) out.hooks = true;
  }
  for (const c of out.conflicts) {
    ctx.journal.add({ cmd: `collision: ${c.path} (${c.incoming} ≠ ${c.existing}) — kept existing`, cwd: path, mode });
  }
  return out;
}

export function createActionHandler() {
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

      if (url === '/api/launch') {
        const { path, selections = [] } = body;
        const sel = selections.filter((s) => s && s.pack && ((s.skills?.length) || (s.kits?.length) || s.hooks));
        let provisioned = null;
        if (sel.length) {
          try {
            provisioned = await runSelections({ ctx, path, selections: sel, mode });
            await writeProvisionRecord(path, sel);
            const n = provisioned.skills.length, k = provisioned.kits.length;
            ctx.journal.add({ cmd: `provision: ${n} skill(s)${k ? `, ${k} kit(s)` : ''}${provisioned.hooks ? ', gates' : ''} → .claude/`, cwd: path, mode });
          } catch (e) {
            return sendJson(res, { error: `provision failed: ${e}` }, 500);
          }
        }
        ctx.journal.add({ cmd: 'claude', cwd: path, mode: 'guided' });
        const r = await launchInteractive({ worktreePath: path, app: ctx.config.terminalApp, title: worktreeTitle(path) });
        const scope = await resolveSessionScope(path);
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
          launchInteractive({ worktreePath: path, app: ctx.config.terminalApp, title: worktreeTitle(path) });
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
