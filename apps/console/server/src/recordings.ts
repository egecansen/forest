import fs from 'node:fs/promises';
import path from 'node:path';
import type { Recording } from './types.js';

const VIDEO_EXT = '.webm';
const SCAN_ROOTS = ['test-results', path.join('tests', 'e2e', 'evidence')];

/**
 * Depth-bounded, tolerant directory walk. Collects every file path under `dir`
 * into `out`. An unreadable/missing directory yields nothing (never throws);
 * recursion is capped at depth 8 so a symlink cycle or a pathological tree can
 * never spin forever.
 */
async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 8) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, depth + 1, out);
    else out.push(full);
  }
}

/**
 * Discover video/trace/screenshot artifacts under a project. Total — never
 * throws: a missing project, missing scan roots, or an unstattable file all
 * degrade to fewer (or zero) results rather than an error. Videos + traces
 * sort first, then screenshots, each group stable by `relPath`.
 */
export async function findRecordings(projectPath: string): Promise<Recording[]> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) await walk(path.join(projectPath, root), 0, files);
  const out: Recording[] = [];
  for (const full of files) {
    const relPath = path.relative(projectPath, full);
    const base = path.basename(full);
    let kind: Recording['kind'] | null = null;
    if (base.endsWith(VIDEO_EXT)) kind = 'video';
    else if (base === 'trace.zip') kind = 'trace';
    else if (base.endsWith('.png')) kind = 'screenshot';
    if (!kind) continue;
    let bytes = 0;
    try {
      bytes = (await fs.stat(full)).size;
    } catch {
      /* ignore — file vanished between walk and stat; report 0 bytes */
    }
    out.push({ id: relPath, kind, relPath, label: relPath, bytes });
  }
  // videos + traces first, then screenshots; stable by path within each group.
  const order = { video: 0, trace: 1, screenshot: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.relPath.localeCompare(b.relPath));
}
