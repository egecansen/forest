import { describe, expect, it, vi } from 'vitest';
import { reserveTestbox, releaseTestbox, normalizeBox } from '../trackers/srp.js';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const errJson = (status: number) => ({ ok: false, status, json: async () => ({ error: 'nope' }) });

const cfg = { baseUrl: 'https://srp.example/gw/', cookie: 'S=abc' };

describe('normalizeBox', () => {
  it('coerces any form to xtbxNNN', () => {
    expect(normalizeBox('tb52')).toBe('xtbx52');
    expect(normalizeBox('52')).toBe('xtbx52');
    expect(normalizeBox('xtbx52')).toBe('xtbx52');
  });
});

describe('reserveTestbox', () => {
  it('POSTs to reservation/v1/records with cookie + normalized box + defaults', async () => {
    const fetchImpl = vi.fn(async () => okJson({ data: { id: 'r1' } }) as unknown as Response);
    const r = await reserveTestbox(cfg, { testbox: 'tb52' }, fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://srp.example/gw/reservation/v1/records'); // trailing slash normalized
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Cookie).toBe('S=abc');
    expect(JSON.parse(init.body as string)).toMatchObject({
      testbox: 'xtbx52',
      durationHours: 24,
      description: 'hektor triage',
    });
  });
  it('omits testbox for an "any free box" reservation', async () => {
    const fetchImpl = vi.fn(async () => okJson({}) as unknown as Response);
    await reserveTestbox(cfg, {}, fetchImpl as unknown as typeof fetch);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty('testbox');
  });
  it('reports SRP failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => errJson(403) as unknown as Response);
    const r = await reserveTestbox(cfg, { testbox: '52' }, fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });
});

describe('releaseTestbox', () => {
  it('POSTs a revoke action keyed by reservation id', async () => {
    const fetchImpl = vi.fn(async () => okJson({ data: 'released' }) as unknown as Response);
    const r = await releaseTestbox(cfg, 'res-123', fetchImpl as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://srp.example/gw/reservation/v1/acts');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'revoke', id: 'res-123' });
  });
});
