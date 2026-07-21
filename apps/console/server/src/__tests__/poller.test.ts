import { describe, expect, it, vi } from 'vitest';
import { BuildsPoller } from '../trackers/poller.js';
import type { ConsoleConfig } from '../console-config.js';

const CFG: ConsoleConfig = {
  repoPath: '/tmp/web-test', testbox: 'tb161',
  jenkins: { baseUrl: 'https://jenkins.example', jobUrls: ['https://jenkins.example/job/web-test-s4-flaky'] },
  es: { url: 'https://es.example', index: 'web-report' },
  reportBase: 'https://report.example', pollMs: 15000,
};

const jenkinsResp = { builds: [{ number: 2127, result: 'FAILURE', timestamp: 1784553554830, duration: 1, building: false,
  displayName: '#2127', estimatedDuration: 1, url: 'https://jenkins.example/job/web-test-s4-flaky/2127/', actions: [] }] };
const esResp = { hits: { total: { value: 12 }, hits: [{ _source: { testBuildName: 'x-web-test-s4-flaky-2127' } }] } };

const fetchImpl = vi.fn(async (url: string) =>
  new Response(JSON.stringify(String(url).includes('_search') ? esResp : jenkinsResp), { status: 200 })
) as unknown as typeof fetch;

describe('BuildsPoller', () => {
  it('assembles BuildRows with failedCount + reportUrl on refresh', async () => {
    const p = new BuildsPoller(CFG, fetchImpl);
    await p.refreshNow();
    const { builds, stale } = p.getBuilds();
    expect(stale).toBe(false);
    expect(builds[0]).toMatchObject({ number: 2127, failedCount: 12 });
    expect(builds[0].reportUrl).toContain('/web-test-s4-flaky/2127?buildStartTime=1784553554830');
    p.stop();
  });

  it('caches ES info for finished builds (no second _search for same build)', async () => {
    (fetchImpl as unknown as { mockClear: () => void }).mockClear();
    const p = new BuildsPoller(CFG, fetchImpl);
    await p.refreshNow();
    await p.refreshNow();
    const esCalls = (fetchImpl as unknown as { mock: { calls: [[string]] } }).mock.calls
      .filter(([u]) => String(u).includes('_search'));
    expect(esCalls).toHaveLength(1);
    p.stop();
  });

  it('keeps last data and marks stale when jenkins fails', async () => {
    let fail = false;
    const f = vi.fn(async (url: string) => fail && !String(url).includes('_search')
      ? new Response('x', { status: 500 })
      : new Response(JSON.stringify(String(url).includes('_search') ? esResp : jenkinsResp), { status: 200 })
    ) as unknown as typeof fetch;
    const p = new BuildsPoller(CFG, f);
    await p.refreshNow();
    fail = true;
    await p.refreshNow();
    const { builds, stale } = p.getBuilds();
    expect(builds).toHaveLength(1);   // last good data kept
    expect(stale).toBe(true);
    p.stop();
  });

  it('fetches stage info for a failed (non-building) build', async () => {
    const wfapi = { stages: [{ name: 'checkout', status: 'SUCCESS' }, { name: 'test', status: 'FAILED' }] };
    const f = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('_search')) return new Response(JSON.stringify(esResp), { status: 200 });
      if (u.includes('wfapi/describe')) return new Response(JSON.stringify(wfapi), { status: 200 });
      return new Response(JSON.stringify(jenkinsResp), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new BuildsPoller(CFG, f);
    await p.refreshNow();
    const { builds } = p.getBuilds();
    expect(builds[0].stage).toEqual({ current: null, failed: 'test', done: 1, total: 2 });
    p.stop();
  });

  it('caches stage info for a finished build (no second wfapi call on refresh)', async () => {
    const wfapi = { stages: [{ name: 'checkout', status: 'SUCCESS' }, { name: 'test', status: 'FAILED' }] };
    const f = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('_search')) return new Response(JSON.stringify(esResp), { status: 200 });
      if (u.includes('wfapi/describe')) return new Response(JSON.stringify(wfapi), { status: 200 });
      return new Response(JSON.stringify(jenkinsResp), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new BuildsPoller(CFG, f);
    await p.refreshNow();
    await p.refreshNow();
    const wfapiCalls = (f as unknown as { mock: { calls: [[string]] } }).mock.calls
      .filter(([u]) => String(u).includes('wfapi/describe'));
    expect(wfapiCalls).toHaveLength(1);
    p.stop();
  });

  it('does not cache stage info for a running build — refetches every poll', async () => {
    const runningResp = { builds: [{ number: 2128, result: null, timestamp: 1784553554830, duration: 0, building: true,
      displayName: '#2128', estimatedDuration: 1, url: 'https://jenkins.example/job/web-test-s4-flaky/2128/', actions: [] }] };
    const wfapi = { stages: [{ name: 'checkout', status: 'SUCCESS' }, { name: 'test', status: 'IN_PROGRESS' }] };
    const f = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('_search')) return new Response(JSON.stringify(esResp), { status: 200 });
      if (u.includes('wfapi/describe')) return new Response(JSON.stringify(wfapi), { status: 200 });
      return new Response(JSON.stringify(runningResp), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new BuildsPoller(CFG, f);
    await p.refreshNow();
    await p.refreshNow();
    const wfapiCalls = (f as unknown as { mock: { calls: [[string]] } }).mock.calls
      .filter(([u]) => String(u).includes('wfapi/describe'));
    expect(wfapiCalls).toHaveLength(2);
    p.stop();
  });

  it('does not fetch stage info for a finished SUCCESS build', async () => {
    const successResp = { builds: [{ number: 2129, result: 'SUCCESS', timestamp: 1784553554830, duration: 1, building: false,
      displayName: '#2129', estimatedDuration: 1, url: 'https://jenkins.example/job/web-test-s4-flaky/2129/', actions: [] }] };
    const f = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('_search')) return new Response(JSON.stringify(esResp), { status: 200 });
      return new Response(JSON.stringify(successResp), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new BuildsPoller(CFG, f);
    await p.refreshNow();
    const { builds } = p.getBuilds();
    expect(builds[0].stage).toBeNull();
    const wfapiCalls = (f as unknown as { mock: { calls: [[string]] } }).mock.calls
      .filter(([u]) => String(u).includes('wfapi/describe'));
    expect(wfapiCalls).toHaveLength(0);
    p.stop();
  });
});
