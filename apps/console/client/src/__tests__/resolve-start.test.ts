import { describe, it, expect, vi } from 'vitest';
import { resolveStart, startResolutionNote, reserveBox } from '../start-logic';

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const bad = (status: number, error?: string) => ({ ok: false, status, json: async () => ({ error }) });

/** Route the two POSTs by path. */
const routed = (report: unknown, testbox: unknown) =>
  vi.fn(async (path: string) => (path.includes('resolve-report') ? report : testbox) as unknown as Response);

describe('startResolutionNote', () => {
  it('summarizes each source', () => {
    expect(startResolutionNote({ testbox: 'tb230', source: 'report-dedicated', jiraTicket: 'DEP-11495' })).toMatch(
      /tb230.*dedicated.*DEP-11495/
    );
    expect(startResolutionNote({ testbox: 'tb215', source: 'srp-reservation', alternatives: ['tb51'] })).toMatch(
      /tb215.*reserved.*tb51/
    );
    expect(startResolutionNote({ testbox: 'tb161', source: 'user' })).toMatch(/using tb161/);
  });
});

describe('resolveStart', () => {
  it('Jenkins URL → report targetUrl + DEP- dedicated box', async () => {
    const fetchImpl = routed(
      ok({ targetUrl: 'https://report.example/web-test-s4-flaky/2171?fullTestBuildName=x', source: 'jenkins' }),
      ok({ status: 'resolved', testbox: 'tb230', source: 'report-dedicated', jiraTicket: 'DEP-11495' })
    );
    const r = await resolveStart('https://jenkins.example/job/x/2171/', '', fetchImpl as unknown as typeof fetch);
    expect(r.targetUrl).toContain('/web-test-s4-flaky/2171');
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb230', source: 'report-dedicated' });
    expect(r.note).toMatch(/tb230/);
  });

  it('SHBDN- with no reservation → needs-reservation (note carries the reason)', async () => {
    const fetchImpl = routed(
      ok({ targetUrl: 'https://report.example/web-test-s4-tag/1?fullTestBuildName=x' }),
      ok({ status: 'needs-reservation', jiraTicket: 'SHBDN-1', reason: 'reserve a box' })
    );
    const r = await resolveStart('https://report.example/web-test-s4-tag/1?fullTestBuildName=x', '', fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ status: 'needs-reservation', note: 'reserve a box' });
  });

  it('passes a user-typed box through so it wins server-side', async () => {
    const fetchImpl = routed(
      ok({ targetUrl: 'https://report.example/j/1?fullTestBuildName=x' }),
      ok({ status: 'resolved', testbox: 'tb161', source: 'user' })
    );
    await resolveStart('https://report.example/j/1?fullTestBuildName=x', '161', fetchImpl as unknown as typeof fetch);
    const testboxCall = fetchImpl.mock.calls.find(([p]) => String(p).includes('resolve-testbox')) as
      | unknown[]
      | undefined;
    const init = (testboxCall as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toMatchObject({ testbox: 'tb161' });
  });

  it('surfaces a resolve-report error without throwing', async () => {
    const fetchImpl = vi.fn(async () => bad(422, 'no ES doc yet') as unknown as Response);
    const r = await resolveStart('https://jenkins.example/job/x/9/', '', fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ status: 'error', note: 'no ES doc yet' });
  });
});

describe('reserveBox', () => {
  it('POSTs confirm:true and reports success', async () => {
    const fetchImpl = vi.fn(async () => ok({ ok: true }) as unknown as Response);
    const r = await reserveBox(undefined, fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/reserve-testbox');
    expect(JSON.parse(init.body as string)).toMatchObject({ confirm: true });
  });
  it('surfaces the server error without throwing', async () => {
    const fetchImpl = vi.fn(async () => bad(503, 'SRP not configured') as unknown as Response);
    const r = await reserveBox('tb52', fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, note: 'SRP not configured' });
  });
});
