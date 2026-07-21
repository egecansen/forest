import { describe, expect, it, vi } from 'vitest';
import { fetchBuildFailInfo, sReportUrl } from '../trackers/es.js';

const ES = { url: 'https://es.example', index: 'web-report' };
const HIT = { _source: { testBuildName: '2026.07.20-16:19-ngn-qa-webautomation-web-test-s4-flaky-2127' } };
const RESP = { hits: { total: { value: 12 }, hits: [HIT] } };

describe('es tracker', () => {
  it('returns failed count + exact testBuildName in one query', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(RESP), { status: 200 })) as unknown as typeof fetch;
    const info = await fetchBuildFailInfo(ES, 'web-test-s4-flaky', 2127, fetchImpl);
    expect(info).toEqual({ failedCount: 12, testBuildName: HIT._source.testBuildName });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [[string, RequestInit]] } }).mock.calls[0];
    expect(url).toBe('https://es.example/web-report/_search');
    const body = JSON.parse(init.body as string);
    expect(JSON.stringify(body.query)).toContain('*web-test-s4-flaky-2127');
    expect(JSON.stringify(body.query)).toContain('FAILED');
  });

  it('returns zero/null on ES failure (never throws — board degrades)', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(await fetchBuildFailInfo(ES, 'j', 1, fetchImpl)).toEqual({ failedCount: 0, testBuildName: null });
  });

  it('constructs the s-report URL the kit ingests', () => {
    const u = sReportUrl('https://report.example', 'web-test-s4-flaky', 2127, 1784553554830,
      '2026.07.20-16:19-ngn-qa-webautomation-web-test-s4-flaky-2127');
    expect(u).toBe('https://report.example/web-test-s4-flaky/2127?buildStartTime=1784553554830&fullTestBuildName=2026.07.20-16%3A19-ngn-qa-webautomation-web-test-s4-flaky-2127');
  });
});
