import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowseResult } from './types.js';

/** List the subdirectories of a path (or the home dir if none). May throw on an unreadable dir. */
export async function listDirectories(rawPath?: string): Promise<BrowseResult> {
  const target = rawPath && rawPath.trim() ? path.resolve(rawPath.trim()) : os.homedir();
  const entries = await fs.readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, parent: parent === target ? null : parent, dirs };
}
