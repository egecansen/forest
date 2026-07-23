import { describe, expect, it, vi } from 'vitest';
import {
  fetchReservationRecords,
  toSrpReservations,
  type SrpReservationRecord,
} from '../trackers/srp.js';
import { resolveTestbox } from '../testbox-routing.js';

// Trimmed from a real reservation/v1/records response for egecan.sen.
const RECORDS: SrpReservationRecord[] = [
  { username: 'egecan.sen', testbox: 'xtbx215', status: 'OK', endDate: '2026-07-24T14:46:39.471+03:00' },
  { username: 'egecan.sen', testbox: 'xtbx51', status: 'OK', endDate: '2026-07-24T14:00:57.447+03:00' },
  { username: 'someone.else', testbox: 'xtbx99', status: 'OK' },
  { username: 'egecan.sen', testbox: 'xtbx7', status: 'EXPIRED' },
];

const envelope = (records: SrpReservationRecord[]) => ({
  ok: true,
  json: async () => ({ data: { records, numberOfRecords: records.length }, error: null }),
});

describe('toSrpReservations', () => {
  it('keeps only the given user, passing status through', () => {
    const mine = toSrpReservations(RECORDS, 'egecan.sen');
    expect(mine).toEqual([
      { testbox: 'xtbx215', status: 'OK' },
      { testbox: 'xtbx51', status: 'OK' },
      { testbox: 'xtbx7', status: 'EXPIRED' },
    ]);
  });
  it('is case-insensitive on username and excludes other users', () => {
    expect(toSrpReservations(RECORDS, 'EGECAN.SEN').map((r) => r.testbox)).not.toContain('xtbx99');
  });
});

describe('fetchReservationRecords', () => {
  it('GETs reservation/v1/records with the session cookie and unwraps data.records', async () => {
    const fetchImpl = vi.fn(async () => envelope(RECORDS) as unknown as Response);
    const out = await fetchReservationRecords(
      { baseUrl: 'https://srp.example/gw/', cookie: 'SESSION=abc' },
      fetchImpl as unknown as typeof fetch
    );
    expect(out).toHaveLength(4);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://srp.example/gw/reservation/v1/records'); // trailing slash normalized
    expect((init.headers as Record<string, string>).Cookie).toBe('SESSION=abc');
  });
  it('throws a clear error on non-OK', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response);
    await expect(
      fetchReservationRecords({ baseUrl: 'https://srp.example' }, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/HTTP 401/);
  });
});

describe('srp → routing (end-to-end for a SHBDN- run)', () => {
  it('resolves a dev-branch run to a box the user holds', () => {
    const userReservations = toSrpReservations(RECORDS, 'egecan.sen');
    const r = resolveTestbox({ jiraTicket: 'SHBDN-253190', userReservations });
    expect(r).toMatchObject({ status: 'resolved', testbox: 'tb215', source: 'srp-reservation' });
    expect(r).toMatchObject({ alternatives: ['tb51'] }); // xtbx7 dropped (EXPIRED)
  });
});
