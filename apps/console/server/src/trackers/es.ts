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
