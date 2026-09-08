#!/usr/bin/env node
// bin/migrate-hooks-to-dispatcher.mjs — convert a repo's hand-maintained
// per-script hook registrations to the dispatcher scheme (phase 3 of
// docs/superpowers/specs/2026-08-05-hook-dispatcher-design.md).
//
//   node bin/migrate-hooks-to-dispatcher.mjs /path/to/repo           # dry-run
//   node bin/migrate-hooks-to-dispatcher.mjs /path/to/repo --apply
//
// Dry-run prints the plan and writes nothing. --apply backs each settings
// file up to <name>.pre-dispatcher first, then rewrites registrations,
// creates the .d symlinks, and writes dispatch.sh (byte-identical to the one
// forest provisions — both come from lib/packs.mjs).
//
// Registrations whose command matches KEEP (default: the flaky-kit gates) are
// left untouched: the kit's wiring axis (core/lock-kit.sh and friends) reads
// those exact lines from settings.json, and converting them before the kit
// itself adopts the dispatcher (rollout phase 2) would make a locked kit
// refuse every entrypoint with rc 76. Inline commands and paths outside the
// repo's .claude/ are also kept verbatim.
//
// This is an OPERATOR tool by design: the kit's self-protection gate blocks
// agents from editing settings files, and that wall is correct. Run it from
// your own terminal.
import { readFile, writeFile, copyFile, mkdir, unlink, symlink } from 'node:fs/promises';
import { join, dirname, basename, relative, resolve, isAbsolute } from 'node:path';
import { matcherSlug, ensureDispatcher } from '../lib/packs.mjs';
import { resolveHookFile } from '../lib/session-scope.mjs';

const KEEP = /flaky-kit-/;   // phase-2 boundary — see header
const SETTINGS = ['settings.json', 'settings.local.json'];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const project = resolve(args.find((a) => !a.startsWith('--')) || '');
if (!project || project === resolve('')) {
  console.error('usage: migrate-hooks-to-dispatcher.mjs /path/to/repo [--apply]');
  process.exit(2);
}

const claudeDir = join(project, '.claude');
const hooksDir = join(claudeDir, 'hooks');
const dispatchCmd = (slug) => `"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh" ${slug}`;
const plan = [];        // human-readable actions
const links = [];       // { link, target } to create on --apply
let touched = 0;

for (const name of SETTINGS) {
  const file = join(claudeDir, name);
  let json;
  try { json = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
  let changed = false;
  for (const [event, blocks] of Object.entries(json.hooks || {})) {
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!Array.isArray(block.hooks)) continue;
      const slug = matcherSlug(event, block.matcher);
      const dDir = join(hooksDir, `${slug}.d`);
      const kept = [];
      let order = 10;
      let linked = 0;
      let timeout = 10;
      for (const h of block.hooks) {
        const cmd = String(h.command || '');
        if (cmd.startsWith('"$CLAUDE_PROJECT_DIR/.claude/hooks/dispatch.sh"')) { kept.push(h); continue; }
        const target = resolveHookFile(cmd, project);
        const convertible = target
          && target.startsWith(claudeDir + '/')
          && !KEEP.test(cmd);
        if (!convertible) { kept.push(h); continue; }
        const link = join(dDir, `${String(order).padStart(2, '0')}-${basename(target)}`);
        order += 10;
        links.push({ link, target });
        timeout = Math.max(timeout, h.timeout || 0);
        linked += 1;
        changed = true;
        plan.push(`link    ${relative(project, link)} -> ${relative(dDir, target)}`);
      }
      if (linked) {
        const line = { type: 'command', command: dispatchCmd(slug), timeout };
        if (!kept.some((x) => x.command === line.command)) kept.unshift(line);
        plan.push(`rewrite ${name}: ${event}/${block.matcher ?? '*'} — ${linked} script line(s) -> 1 dispatcher line (${kept.length} total kept)`);
      }
      block.hooks = kept;
    }
  }
  if (changed) {
    touched += 1;
    if (apply) {
      await copyFile(file, `${file}.pre-dispatcher`);
      await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
    }
    plan.push(`backup  ${name} -> ${name}.pre-dispatcher`);
  }
}

if (!plan.length) {
  console.log(`${project}: nothing to migrate — no convertible per-script registrations found.`);
  process.exit(0);
}

for (const line of plan) console.log(`${apply ? '' : '[dry-run] '}${line}`);

if (apply) {
  for (const { link, target } of links) {
    await mkdir(dirname(link), { recursive: true });
    try { await unlink(link); } catch { /* absent */ }
    await symlink(relative(dirname(link), target), link);
  }
  await ensureDispatcher(hooksDir);
  console.log(`done: ${links.length} symlink(s), ${touched} settings file(s) rewritten, dispatch.sh written.`);
  console.log('Restart any Claude Code session running in this repo — hook config is snapshotted at session start.');
} else {
  console.log(`\ndry-run only — re-run with --apply to write. ${links.length} symlink(s), ${touched} settings file(s) would change.`);
}
