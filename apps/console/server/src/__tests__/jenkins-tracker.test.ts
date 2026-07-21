import { describe, expect, it, vi } from 'vitest';
import { fetchJobBuilds } from '../trackers/jenkins.js';

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
      params: { TAG: 'Bireysel', JIRA_TICKET: 'CI-123' }, buildUser: 'egecan.sen' });
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
