import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirectories } from '../browse.js';

let tmp: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'browse-test-'));
  await fs.mkdir(path.join(tmp, 'zeta'));
  await fs.mkdir(path.join(tmp, 'alpha'));
  await fs.writeFile(path.join(tmp, 'a-file.txt'), 'not a directory');
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('listDirectories', () => {
  it('lists only subdirectories, sorted by name, with correct paths', async () => {
    const result = await listDirectories(tmp);
    expect(result.path).toBe(tmp);
    expect(result.parent).not.toBeNull();
    expect(result.dirs).toEqual([
      { name: 'alpha', path: path.join(tmp, 'alpha') },
      { name: 'zeta', path: path.join(tmp, 'zeta') },
    ]);
  });

  it('defaults to the home directory when no path is given', async () => {
    const result = await listDirectories();
    expect(result.path).toBe(os.homedir());
  });
});
