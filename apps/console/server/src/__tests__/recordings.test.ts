import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRecordings } from '../recordings.js';

let dir: string;

const write = async (rel: string, contents = 'x') => {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, 'utf8');
  return full;
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hektor-demo-recordings-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('findRecordings', () => {
  it('discovers video/trace/screenshot and ignores everything else', async () => {
    await write(path.join('test-results', 'a', 'video.webm'), 'VIDEODATA');
    await write(path.join('test-results', 'a', 'trace.zip'));
    await write(path.join('test-results', 'a', 'notes.txt')); // ignored: bad ext
    await write(path.join('test-results', 'a', 'other.zip')); // ignored: only trace.zip counts
    await write(path.join('tests', 'e2e', 'evidence', 'x-1', 'screenshots', '01.png'));
    await write(path.join('tests', 'e2e', 'docs', 'journey-map.md')); // ignored: not a scan root

    const recs = await findRecordings(dir);

    expect(recs.map((r) => r.relPath)).toEqual([
      path.join('test-results', 'a', 'video.webm'),
      path.join('test-results', 'a', 'trace.zip'),
      path.join('tests', 'e2e', 'evidence', 'x-1', 'screenshots', '01.png'),
    ]);
    expect(recs.map((r) => r.kind)).toEqual(['video', 'trace', 'screenshot']);
    // id + label mirror relPath; bytes reflect real file size.
    expect(recs[0].id).toBe(recs[0].relPath);
    expect(recs[0].label).toBe(recs[0].relPath);
    expect(recs[0].bytes).toBe(Buffer.byteLength('VIDEODATA'));
  });

  it('orders videos + traces before screenshots, stable by path within a group', async () => {
    await write(path.join('test-results', 'b', 'video.webm'));
    await write(path.join('test-results', 'a', 'video.webm'));
    await write(path.join('tests', 'e2e', 'evidence', 'aa.png'));
    await write(path.join('tests', 'e2e', 'evidence', 'z', '01.png'));
    await write(path.join('test-results', 'a', 'trace.zip'));

    const recs = await findRecordings(dir);
    expect(recs.map((r) => `${r.kind}:${r.relPath}`)).toEqual([
      `video:${path.join('test-results', 'a', 'video.webm')}`,
      `video:${path.join('test-results', 'b', 'video.webm')}`,
      `trace:${path.join('test-results', 'a', 'trace.zip')}`,
      `screenshot:${path.join('tests', 'e2e', 'evidence', 'aa.png')}`,
      `screenshot:${path.join('tests', 'e2e', 'evidence', 'z', '01.png')}`,
    ]);
  });

  it('is tolerant of a missing project (returns [])', async () => {
    const recs = await findRecordings(path.join(dir, 'does-not-exist'));
    expect(recs).toEqual([]);
  });

  it('returns [] when the scan roots are absent but the project exists', async () => {
    await write(path.join('src', 'index.ts')); // unrelated file, not under a scan root
    const recs = await findRecordings(dir);
    expect(recs).toEqual([]);
  });
});
