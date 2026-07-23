import type { ConsoleConfig } from '../console-config.js';

/** One query serves both board needs: FAILED hit total for the build, and one
 *  sample doc's exact `testBuildName` (needed for the s-report URL — it carries
 *  a datetime prefix we must not reconstruct locally). Total on failure. */
export async function fetchBuildFailInfo(
  es: ConsoleConfig['es'], jobName: string, buildNumber: number, fetchImpl: typeof fetch = fetch
): Promise<{ failedCount: number; testBuildName: string | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (es.username && es.password)
    headers.Authorization = `Basic ${Buffer.from(`${es.username}:${es.password}`).toString('base64')}`;
  const body = {
    size: 1,
    _source: ['testBuildName'],
    query: { bool: { must: [
      { wildcard: { 'testBuildName.keyword': `*${jobName}-${buildNumber}` } },
      { term: { 'testStatus.keyword': 'FAILED' } },
    ] } },
    track_total_hits: true,
  };
  try {
    const res = await fetchImpl(`${es.url}/${es.index}/_search`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      hits?: { total?: { value?: number } | number; hits?: Array<{ _source?: { testBuildName?: string } }> };
    };
    const t = data.hits?.total;
    const failedCount = typeof t === 'number' ? t : t?.value ?? 0;
    return { failedCount, testBuildName: data.hits?.hits?.[0]?._source?.testBuildName ?? null };
  } catch {
    return { failedCount: 0, testBuildName: null };
  }
}

export function sReportUrl(
  reportBase: string, jobName: string, buildNumber: number, buildStartTime: number, fullTestBuildName: string
): string {
  const u = new URL(`${reportBase.replace(/\/+$/, '')}/${jobName}/${buildNumber}`);
  u.searchParams.set('buildStartTime', String(buildStartTime));
  u.searchParams.set('fullTestBuildName', fullTestBuildName);
  return u.toString();
}

/** The two facts the box-router needs from a build's FAILED docs: the
 *  build-level `jiraTicket` (e.g. "DEP-11495" / "SHBDN-253190") and the set of
 *  `testbox` values the run used. Returns empty facts on any failure so the
 *  router degrades to a user-provided box rather than throwing. */
export async function fetchBuildFacts(
  es: ConsoleConfig['es'],
  jobName: string,
  buildNumber: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ jiraTicket: string | null; testboxes: Array<string | number> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (es.username && es.password)
    headers.Authorization = `Basic ${Buffer.from(`${es.username}:${es.password}`).toString('base64')}`;
  const body = {
    size: 200,
    _source: ['jiraTicket', 'testbox'],
    query: { bool: { must: [
      { wildcard: { 'testBuildName.keyword': `*${jobName}-${buildNumber}` } },
      { term: { 'testStatus.keyword': 'FAILED' } },
    ] } },
  };
  try {
    const res = await fetchImpl(`${es.url}/${es.index}/_search`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      hits?: { hits?: Array<{ _source?: { jiraTicket?: string; testbox?: string | number } }> };
    };
    const hits = data.hits?.hits ?? [];
    let jiraTicket: string | null = null;
    const testboxes: Array<string | number> = [];
    for (const h of hits) {
      const s = h._source ?? {};
      if (!jiraTicket && typeof s.jiraTicket === 'string' && s.jiraTicket) jiraTicket = s.jiraTicket;
      if (s.testbox !== undefined && s.testbox !== null) testboxes.push(s.testbox);
    }
    return { jiraTicket, testboxes };
  } catch {
    return { jiraTicket: null, testboxes: [] };
  }
}
