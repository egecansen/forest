import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectPath, agentStateFromMtime, detectAgentState } from './agents.mjs';

test('encodeProjectPath replaces slashes and dots with dashes', () => {
  assert.equal(
    encodeProjectPath('/Users/egecan.sen/sahibinden/repo'),
    '-Users-egecan-sen-sahibinden-repo',
  );
  assert.equal(
    encodeProjectPath('/r/web-test/.claude/worktrees/no-flag-map'),
    '-r-web-test--claude-worktrees-no-flag-map',
  );
});

test('agentStateFromMtime: fresh = running, old = idle', () => {
  const now = 1_000_000;
  assert.equal(agentStateFromMtime(now - 5000, now), 'running');
  assert.equal(agentStateFromMtime(now - 60000, now), 'idle');
});

test('detectAgentState: registry session wins as running', async () => {
  const registry = new Map([['/wt/a', { pid: 42, kind: 'claude' }]]);
  const r = await detectAgentState({ worktreePath: '/wt/a', claudeProjectsDir: '/nope', nowMs: 0, registry });
  assert.equal(r.state, 'running');
  assert.equal(r.source, 'registry');
  assert.equal(r.pid, 42);
});

test('detectAgentState: unknown when no signal', async () => {
  const r = await detectAgentState({ worktreePath: '/wt/none', claudeProjectsDir: '/nope', nowMs: 0, registry: new Map() });
  assert.equal(r.state, 'unknown');
  assert.equal(r.source, null);
});

test('detectAgentState: fresh transcript => running via session-file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forest-'));
  try {
    const wt = join(base, 'wt', 'demo');
    const projects = join(base, 'projects');
    const encoded = encodeProjectPath(wt);
    const projDir = join(projects, encoded);
    await mkdir(projDir, { recursive: true });
    const transcript = join(projDir, 'session.jsonl');
    await writeFile(transcript, '{}');
    const now = Date.now();
    await utimes(transcript, new Date(now), new Date(now));
    const r = await detectAgentState({ worktreePath: wt, claudeProjectsDir: projects, nowMs: now, registry: new Map() });
    assert.equal(r.state, 'running');
    assert.equal(r.source, 'session-file');
    assert.equal(r.kind, 'claude');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('detectAgentState: stale transcript => idle via session-file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forest-'));
  try {
    const wt = join(base, 'wt', 'stale');
    const projects = join(base, 'projects');
    const projDir = join(projects, encodeProjectPath(wt));
    await mkdir(projDir, { recursive: true });
    const transcript = join(projDir, 'session.jsonl');
    await writeFile(transcript, '{}');
    const old = 1_000_000;
    await utimes(transcript, new Date(old), new Date(old));
    const r = await detectAgentState({ worktreePath: wt, claudeProjectsDir: projects, nowMs: old + 60_000, registry: new Map() });
    assert.equal(r.state, 'idle');
    assert.equal(r.source, 'session-file');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('detectAgentState: project dir exists but has no .jsonl => unknown', async () => {
  const base = await mkdtemp(join(tmpdir(), 'forest-'));
  try {
    const wt = join(base, 'wt', 'empty');
    const projects = join(base, 'projects');
    const projDir = join(projects, encodeProjectPath(wt));
    await mkdir(projDir, { recursive: true });
    const r = await detectAgentState({ worktreePath: wt, claudeProjectsDir: projects, nowMs: Date.now(), registry: new Map() });
    assert.equal(r.state, 'unknown');
    assert.equal(r.source, null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
