import { describe, expect, it } from 'vitest';
import { runStore } from '../run-store.js';
import { makeRedactor } from '../redact.js';
import type { ServerEvent } from '../types.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };

describe('Run.setSelenoidUrl', () => {
  it('sets snapshot.selenoidUrl, emits a selenoidUrl event, and logs one success entry', () => {
    const run = runStore.create(cfg);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));

    run.setSelenoidUrl('https://selenoid.example/ui/#/sessions/abc123');

    expect(run.snapshot.selenoidUrl).toBe('https://selenoid.example/ui/#/sessions/abc123');
    expect(events).toContainEqual({ type: 'selenoidUrl', url: 'https://selenoid.example/ui/#/sessions/abc123' });
    const watchLiveEntries = run.snapshot.log.filter((l) => l.text.startsWith('watch live:'));
    expect(watchLiveEntries).toHaveLength(1);
    expect(watchLiveEntries[0]).toMatchObject({
      kind: 'success',
      text: 'watch live: https://selenoid.example/ui/#/sessions/abc123',
    });
  });

  it('is a no-op (no re-emit, no re-log) when called again with the SAME url', () => {
    const run = runStore.create(cfg);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));

    run.setSelenoidUrl('https://selenoid.example/ui/#/sessions/abc123');
    run.setSelenoidUrl('https://selenoid.example/ui/#/sessions/abc123');

    const selenoidEvents = events.filter((e) => e.type === 'selenoidUrl');
    expect(selenoidEvents).toHaveLength(1);
    const watchLiveEntries = run.snapshot.log.filter((l) => l.text.startsWith('watch live:'));
    expect(watchLiveEntries).toHaveLength(1);
  });

  it('surfaces a DIFFERENT url again (a rerun spins a fresh session)', () => {
    const run = runStore.create(cfg);
    run.setSelenoidUrl('https://selenoid.example/ui/#/sessions/abc123');
    run.setSelenoidUrl('https://selenoid.example/ui/#/sessions/def456');

    expect(run.snapshot.selenoidUrl).toBe('https://selenoid.example/ui/#/sessions/def456');
    const watchLiveEntries = run.snapshot.log.filter((l) => l.text.startsWith('watch live:'));
    expect(watchLiveEntries).toHaveLength(2);
  });

  it('routes the url through the injected secretRedactor like other log text', () => {
    const SECRET = 'sekret-token-123';
    const redactor = makeRedactor([SECRET]);
    const run = runStore.create(cfg, redactor);
    run.setSelenoidUrl(`https://selenoid.example/ui/#/sessions/${SECRET}`);
    expect(run.snapshot.selenoidUrl).toBe('https://selenoid.example/ui/#/sessions/«redacted»');
  });
});
