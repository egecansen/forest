import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { runInTerminal } from './terminal.mjs';

export function encodeProjectPath(absPath) {
  return absPath.replace(/[/.]/g, '-');
}

export function agentStateFromMtime(mtimeMs, nowMs, threshold = 15000) {
  return nowMs - mtimeMs <= threshold ? 'running' : 'idle';
}

export async function detectAgentState({ worktreePath, claudeProjectsDir, nowMs, registry }) {
  const reg = registry.get(worktreePath);
  if (reg) return { state: 'running', kind: reg.kind ?? 'claude', source: 'registry', pid: reg.pid };

  // Session-file heuristic: newest *.jsonl mtime under the encoded project dir.
  try {
    const dir = join(claudeProjectsDir, encodeProjectPath(worktreePath));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    let newest = 0;
    for (const f of files) {
      const s = await stat(join(dir, f));
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    }
    if (newest > 0) {
      return { state: agentStateFromMtime(newest, nowMs), kind: 'claude', source: 'session-file', pid: null };
    }
  } catch {
    // dir missing / unreadable → no signal
  }
  return { state: 'unknown', kind: null, source: null, pid: null };
}

export function createRegistry() {
  return new Map(); // worktreePath -> { pid, kind }
}

export function notify({ title, message }) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  execFile('osascript', ['-e', script], () => {});
}

export function launchInteractive({ worktreePath, app = 'Terminal' }) {
  return runInTerminal({ command: 'claude', cwd: worktreePath, app });
}

export function runHeadless({ worktreePath, prompt, registry, onOutput, onDone }) {
  const child = spawn('claude', ['-p', prompt], { cwd: worktreePath });
  registry.set(worktreePath, { pid: child.pid, kind: 'claude' });
  child.stdout.on('data', (d) => onOutput?.(d.toString()));
  child.stderr.on('data', (d) => onOutput?.(d.toString()));
  child.on('close', (code) => {
    registry.delete(worktreePath);
    notify({ title: 'Forest', message: `Task finished (${worktreePath.split('/').pop()})` });
    onDone?.(code);
  });
  return child;
}
