import { execFile } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
function asQuote(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

function osascript(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').trim(), error: err ? String(err) : null });
    });
  });
}

// Permission-free fallback: launch `body` in a new Terminal window via a
// self-deleting .command file. Needs no Automation permission. { ok, error }.
async function launchScriptFile({ cwd, body, app = 'Terminal' }) {
  try {
    const dir = join(tmpdir(), 'forest-launch');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `forest-${Date.now()}-${Math.floor(Math.random() * 1e6)}.command`);
    const script = `#!/bin/zsh\ncd ${shQuote(cwd)}\nrm -f ${shQuote(file)}\n${body}\n`;
    await writeFile(file, script, { mode: 0o755 });
    return await new Promise((resolve) => {
      execFile('open', ['-a', app, file], (err) => resolve({ ok: !err, error: err ? String(err) : null }));
    });
  } catch (e) { return { ok: false, error: String(e) }; }
}

// Reuse-or-open a tagged Terminal session for a worktree. If a tab whose custom
// title equals `marker` already exists (and is running a process, when
// requireBusy), focus that tab/window instead of opening another. Otherwise run
// `body` in a new session and tag it. Uses AppleScript (Terminal Automation
// permission); on any failure, falls back to a permission-free .command window.
// Returns { ok, action: 'focused' | 'launched' | 'fallback', error? }.
export async function terminalSession({ marker, body, cwd, app = 'Terminal', requireBusy = true }) {
  const full = `cd ${shQuote(cwd)} && ${body}`;
  const busyCond = requireBusy ? ' and (busy of t)' : '';
  const script = [
    `tell application "${asQuote(app)}"`,
    `  activate`,
    `  set theMarker to "${asQuote(marker)}"`,
    `  set foundTab to missing value`,
    `  set foundWin to missing value`,
    `  repeat with w in windows`,
    `    repeat with t in tabs of w`,
    `      try`,
    `        if (custom title of t is theMarker)${busyCond} then`,
    `          set foundTab to t`,
    `          set foundWin to w`,
    `        end if`,
    `      end try`,
    `    end repeat`,
    `  end repeat`,
    `  if foundTab is not missing value then`,
    `    set selected of foundTab to true`,
    `    set index of foundWin to 1`,
    `    return "focused"`,
    `  end if`,
    `  do script "${asQuote(full)}"`,
    `  set custom title of selected tab of front window to theMarker`,
    `  return "launched"`,
    `end tell`,
  ].join('\n');

  const r = await osascript(script);
  if (r.ok) return { ok: true, action: r.out || 'launched' };
  const fb = await launchScriptFile({ cwd, body, app });
  return { ok: fb.ok, action: 'fallback', error: r.error || fb.error };
}

// `command` is an already-quoted shell fragment (caller contract). Used for
// guided git commands — a fresh window each time is fine here.
export function runInTerminal({ command, cwd, app = 'Terminal' }) {
  return launchScriptFile({ cwd, body: command, app });
}

// Open (or refocus) an interactive shell sitting in `cwd`.
export function openTerminalAt({ cwd, app = 'Terminal' }) {
  return terminalSession({ marker: `Forest shell · ${cwd}`, body: 'exec ${SHELL:-/bin/zsh} -il', cwd, app, requireBusy: false });
}

export function openWith({ path, target, openEditorCmd = 'open -a Cursor', app = 'Terminal' }) {
  if (target === 'finder') { execFile('open', [path], () => {}); return; }
  if (target === 'terminal') { return openTerminalAt({ cwd: path, app }); }
  if (target === 'cursor') {
    // Cursor/VSCode focuses an existing window when the folder is already open.
    const parts = openEditorCmd.split(' ');
    execFile(parts[0], [...parts.slice(1), path], () => {});
  }
}
