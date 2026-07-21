import { describe, expect, it, vi } from 'vitest';
import { fetchJobBuilds, fetchBuildStages, fetchJenkinsUser } from '../trackers/jenkins.js';

const FIXTURE = {
  builds: [{
    number: 2127, result: 'FAILURE', timestamp: 1784553554830, duration: 5400000, building: false,
    displayName: '#2127', estimatedDuration: 5000000,
    url: 'https://jenkins.example/job/web-test-s4-flaky/2127/',
    actions: [
      { parameters: [{ name: 'TAG', value: 'Bireysel' }, { name: 'JIRA_TICKET', value: 'CI-123' }] },
      { causes: [{ userId: 'egecan.sen', userName: 'Egecan Sen' }] },
    ],
  }, {
    number: 2128, result: null, timestamp: 1784560000000, duration: 0, building: true,
    displayName: '#2128', estimatedDuration: 5000000,
    url: 'https://jenkins.example/job/web-test-s4-flaky/2128/', actions: [],
  }],
};

describe('jenkins tracker', () => {
  it('fetches + flattens builds with params and user', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(FIXTURE), { status: 200 })) as unknown as typeof fetch;
    const builds = await fetchJobBuilds({ baseUrl: 'https://jenkins.example', jobUrls: [] },
      'https://jenkins.example/job/web-test-s4-flaky', fetchImpl);
    expect(builds).toHaveLength(2);
    expect(builds[0]).toMatchObject({ jobName: 'web-test-s4-flaky', number: 2127, result: 'FAILURE',
      params: { TAG: 'Bireysel', JIRA_TICKET: 'CI-123' }, buildUser: 'egecan.sen', estimatedDuration: 5000000 });
    expect(builds[1].building).toBe(true);
    const calledUrl = (fetchImpl as unknown as { mock: { calls: [[string]] } }).mock.calls[0][0];
    expect(calledUrl).toContain('/api/json?tree=builds[');
  });

  it('sends basic auth when apiToken configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ builds: [] }), { status: 200 })) as unknown as typeof fetch;
    await fetchJobBuilds({ baseUrl: 'https://jenkins.example', jobUrls: [], username: 'u', apiToken: 't' },
      'https://jenkins.example/job/x', fetchImpl);
    const init = (fetchImpl as unknown as { mock: { calls: [[string, RequestInit]] } }).mock.calls[0][1];
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('throws on HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchJobBuilds({ baseUrl: 'x', jobUrls: [] }, 'https://jenkins.example/job/x', fetchImpl)).rejects.toThrow('503');
  });
});

describe('fetchBuildStages', () => {
  const CFG = { baseUrl: 'https://jenkins.example', jobUrls: [] };

  it('parses a running build: current IN_PROGRESS stage + SUCCESS count', async () => {
    const wfapi = { stages: [
      { name: 'checkout', status: 'SUCCESS' },
      { name: 'install', status: 'SUCCESS' },
      { name: 'test', status: 'IN_PROGRESS' },
      { name: 'report', status: 'NOT_EXECUTED' },
    ] };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://jenkins.example/job/web-test-s4-flaky/2128/wfapi/describe');
      return new Response(JSON.stringify(wfapi), { status: 200 });
    }) as unknown as typeof fetch;
    const info = await fetchBuildStages(CFG, 'https://jenkins.example/job/web-test-s4-flaky/2128/', fetchImpl);
    expect(info).toEqual({ current: 'test', failed: null, done: 2, total: 4 });
  });

  it('parses a failed build: first FAILED stage name', async () => {
    const wfapi = { stages: [
      { name: 'checkout', status: 'SUCCESS' },
      { name: 'test', status: 'FAILED' },
      { name: 'report', status: 'NOT_EXECUTED' },
    ] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(wfapi), { status: 200 })) as unknown as typeof fetch;
    const info = await fetchBuildStages(CFG, 'https://jenkins.example/job/web-test-s4-flaky/2127/', fetchImpl);
    expect(info).toEqual({ current: null, failed: 'test', done: 1, total: 3 });
  });

  it('normalizes a double slash when joining buildUrl + wfapi/describe', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://jenkins.example/job/web-test-s4-flaky/2127/wfapi/describe');
      return new Response(JSON.stringify({ stages: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchBuildStages(CFG, 'https://jenkins.example/job/web-test-s4-flaky/2127//', fetchImpl);
  });

  it('sends basic auth when apiToken configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ stages: [] }), { status: 200 })) as unknown as typeof fetch;
    await fetchBuildStages({ ...CFG, username: 'u', apiToken: 't' }, 'https://jenkins.example/job/x/1/', fetchImpl);
    const init = (fetchImpl as unknown as { mock: { calls: [[string, RequestInit]] } }).mock.calls[0][1];
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('returns null on HTTP failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const info = await fetchBuildStages(CFG, 'https://jenkins.example/job/x/1/', fetchImpl);
    expect(info).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const info = await fetchBuildStages(CFG, 'https://jenkins.example/job/x/1/', fetchImpl);
    expect(info).toBeNull();
  });
});

describe('fetchJenkinsUser', () => {
  const CFG = { baseUrl: 'https://jenkins.example', jobUrls: [] };

  it('returns the id field from /me/api/json', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://jenkins.example/me/api/json');
      return new Response(JSON.stringify({ id: 'egecan.sen' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchJenkinsUser(CFG, fetchImpl)).toBe('egecan.sen');
  });

  it('normalizes a trailing slash on baseUrl before joining', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://jenkins.example/me/api/json');
      return new Response(JSON.stringify({ id: 'egecan.sen' }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchJenkinsUser({ ...CFG, baseUrl: 'https://jenkins.example/' }, fetchImpl);
  });

  it('sends basic auth when apiToken configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'u' }), { status: 200 })) as unknown as typeof fetch;
    await fetchJenkinsUser({ ...CFG, username: 'u', apiToken: 't' }, fetchImpl);
    const init = (fetchImpl as unknown as { mock: { calls: [[string, RequestInit]] } }).mock.calls[0][1];
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('returns null on HTTP failure (e.g. anonymous access)', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    expect(await fetchJenkinsUser(CFG, fetchImpl)).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchJenkinsUser(CFG, fetchImpl)).toBeNull();
  });

  it('returns null when the response has no id field', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchJenkinsUser(CFG, fetchImpl)).toBeNull();
  });

  it('returns null when fetch itself rejects (network failure)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    expect(await fetchJenkinsUser(CFG, fetchImpl)).toBeNull();
  });
});
