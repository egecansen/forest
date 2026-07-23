import { describe, expect, it, vi } from 'vitest';
import { resolveRunTestbox, parseReportUrl } from '../resolve-run-testbox.js';
import type { ConsoleConfig } from '../console-config.js';

const cfg = (srp?: ConsoleConfig['srp']): Pick<ConsoleConfig, 'es' | 'srp' | 'jenkins'> => ({
  es: { url: 'https://es.example', index: 'web-report', username: 'u', password: 'p' },
  jenkins: { baseUrl: 'https://jk.example', jobUrls: [], username: 'egecan.sen' },
  srp,
});

const esHits = (jira: string, boxes: Array<string | number>) => ({
  ok: true,
  json: async () => ({ hits: { hits: boxes.map((b) => ({ _source: { jiraTicket: jira, testbox: b } })) } }),
});
const srpRecords = (rows: Array<{ username: string; testbox: string; status: string }>) => ({
  ok: true,
  json: async () => ({ data: { records: rows }, error: null }),
});

const routeBy = (esResp: unknown, srpResp?: unknown) =>
  vi.fn(async (u: string) =>
    (u.includes('/reservation/v1/records') ? srpResp : esResp) as unknown as Response
  );

describe('parseReportUrl', () => {
  it('extracts job + build from an s-report URL', () => {
    expect(
      parseReportUrl('https://report.example/web-test-s4-flaky/2171?buildStartTime=1&fullTestBuildName=x')
    ).toEqual({ jobName: 'web-test-s4-flaky', buildNumber: 2171 });
  });
  it('rejects malformed URLs', () => {
    expect(parseReportUrl('not a url')).toBeNull();
    expect(parseReportUrl('https://report.example/onlyjob')).toBeNull();
  });
});

describe('resolveRunTestbox', () => {
  it('DEP- → the report’s dedicated box (no SRP call needed)', async () => {
    const fetchImpl = routeBy(esHits('DEP-11495', [230, 230, 161]));
    const r = await resolveRunTestbox(cfg(), { jobName: 'web-test-s4-flaky', buildNumber: 2171 }, fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb230', source: 'report-dedicated', jiraTicket: 'DEP-11495' });
  });

  it('SHBDN- → a box the operator holds in SRP', async () => {
    const fetchImpl = routeBy(
      esHits('SHBDN-253190', [999]),
      srpRecords([
        { username: 'egecan.sen', testbox: 'xtbx215', status: 'OK' },
        { username: 'egecan.sen', testbox: 'xtbx51', status: 'OK' },
      ])
    );
    const r = await resolveRunTestbox(
      cfg({ baseUrl: 'https://srp.example/gw', cookie: 'S=1' }),
      { jobName: 'web-test-s4-tag', buildNumber: 2256 },
      fetchImpl as unknown as typeof fetch
    );
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb215', source: 'srp-reservation', jiraTicket: 'SHBDN-253190' });
  });

  it('SHBDN- with SRP down degrades to needs-reservation (does not throw)', async () => {
    const fetchImpl = vi.fn(async (u: string) =>
      (u.includes('/reservation/v1/records')
        ? { ok: false, status: 500 }
        : esHits('SHBDN-1', [161])) as unknown as Response
    );
    const r = await resolveRunTestbox(
      cfg({ baseUrl: 'https://srp.example/gw', cookie: 'S=1' }),
      { jobName: 'web-test-s4-tag', buildNumber: 1 },
      fetchImpl as unknown as typeof fetch
    );
    expect(r).toMatchObject({ status: 'needs-reservation' });
  });

  it('operator override wins and skips SRP entirely', async () => {
    const fetchImpl = routeBy(esHits('SHBDN-1', [999]));
    const r = await resolveRunTestbox(
      cfg({ baseUrl: 'https://srp.example/gw', cookie: 'S=1' }),
      { jobName: 'j', buildNumber: 1, userProvidedTestbox: 'tb161' },
      fetchImpl as unknown as typeof fetch
    );
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb161', source: 'user' });
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('/reservation/v1/records'))).toBe(false);
  });
});
