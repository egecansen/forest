/** Last path segment, for the run-history list's project column. */
export function projectBasename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.at(-1) ?? p;
}

/** Coarse human-relative time (e.g. "3m ago", "2d ago") for the history list. `null` -> em dash. */
export function relativeTime(ts: number | null, now: number): string {
  if (ts == null) return '—';
  const diffMs = Math.max(0, now - ts);
  const sec = Math.round(diffMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(mo / 12);
  return `${yr}y ago`;
}

/**
 * Result of the start-form "detect" action: normalizes the pasted URL (a
 * Jenkins build URL or an s-report URL) to a report `targetUrl`, then routes
 * the testbox by the build's ticket prefix. Pure over two server endpoints so
 * StartScreen just renders it.
 */
export interface StartResolution {
  targetUrl: string;
  /** Canonical "tbNNN" when the box was resolved; absent otherwise. */
  testbox?: string;
  /** 'resolved' | 'needs-reservation' | 'unresolved' | 'error'. */
  status: 'resolved' | 'needs-reservation' | 'unresolved' | 'error';
  source?: string;
  jiraTicket?: string | null;
  /** One-line human note for the form (detection summary or the failure reason). */
  note: string;
  alternatives?: string[];
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const b = (await res.json()) as { error?: string };
    return b.error || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolve a pasted URL for the start form:
 *   POST /api/resolve-report  (Jenkins build URL → s-report targetUrl, or pass-through)
 *   POST /api/resolve-testbox (route the box on the build's ticket prefix)
 * `userTestbox` is the digits the user has typed (or '' when untouched) — passed
 * through so an explicit box wins server-side.
 */
export async function resolveStart(
  url: string,
  userTestbox: string,
  fetchImpl: typeof fetch = fetch
): Promise<StartResolution> {
  const post = (path: string, body: unknown) =>
    fetchImpl(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  let repRes: Response;
  try {
    repRes = await post('/api/resolve-report', { url });
  } catch (e) {
    return { targetUrl: url, status: 'error', note: (e as Error).message };
  }
  if (!repRes.ok) {
    return { targetUrl: url, status: 'error', note: await readError(repRes, `resolve-report HTTP ${repRes.status}`) };
  }
  const { targetUrl } = (await repRes.json()) as { targetUrl: string };

  let tbRes: Response;
  try {
    tbRes = await post('/api/resolve-testbox', {
      targetUrl,
      testbox: userTestbox ? `tb${userTestbox}` : null,
    });
  } catch (e) {
    return { targetUrl, status: 'error', note: (e as Error).message };
  }
  if (!tbRes.ok) {
    return { targetUrl, status: 'error', note: await readError(tbRes, `resolve-testbox HTTP ${tbRes.status}`) };
  }
  const r = (await tbRes.json()) as {
    status: string;
    testbox?: string;
    source?: string;
    jiraTicket?: string | null;
    note?: string;
    reason?: string;
    alternatives?: string[];
  };

  if (r.status === 'resolved') {
    return {
      targetUrl,
      testbox: r.testbox,
      source: r.source,
      jiraTicket: r.jiraTicket,
      alternatives: r.alternatives,
      status: 'resolved',
      note: startResolutionNote(r),
    };
  }
  if (r.status === 'needs-reservation') {
    return { targetUrl, jiraTicket: r.jiraTicket, status: 'needs-reservation', note: r.reason ?? 'no reserved box — reserve one or enter a testbox' };
  }
  return { targetUrl, jiraTicket: r.jiraTicket, status: 'unresolved', note: r.reason ?? 'could not detect a testbox — enter one' };
}

/**
 * Reserve a testbox via the confirm-gated server endpoint (the console's one
 * outward action). Sends `confirm:true` — only ever called from a deliberate
 * "reserve" click. Returns a small result the form renders; never throws.
 */
export async function reserveBox(
  testbox: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; note: string }> {
  try {
    const res = await fetchImpl('/api/reserve-testbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, ...(testbox ? { testbox } : {}) }),
    });
    if (!res.ok) return { ok: false, note: await readError(res, `reserve HTTP ${res.status}`) };
    return { ok: true, note: 'reserved — re-detecting…' };
  } catch (e) {
    return { ok: false, note: (e as Error).message };
  }
}

/** Human one-liner for a resolved routing (exported for the form + tests). */
export function startResolutionNote(r: {
  testbox?: string;
  source?: string;
  jiraTicket?: string | null;
  alternatives?: string[];
}): string {
  const t = r.jiraTicket ? ` for ${r.jiraTicket}` : '';
  const alt = r.alternatives?.length ? ` (also: ${r.alternatives.join(', ')})` : '';
  switch (r.source) {
    case 'report-dedicated':
      return `detected ${r.testbox} — dedicated box${t}`;
    case 'srp-reservation':
      return `detected ${r.testbox} — your reserved box${alt}`;
    case 'user':
      return `using ${r.testbox}`;
    default:
      return `detected ${r.testbox}`;
  }
}
