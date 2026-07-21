import type { ConsoleConfig } from '../console-config.js';

export interface JenkinsBuild {
  jobName: string; number: number; building: boolean; result: string | null;
  timestamp: number; duration: number; estimatedDuration: number; url: string; displayName: string;
  params: Record<string, string>; buildUser: string | null;
}

/** Per-build wfapi/describe digest — `current`/`failed` are stage *names*
 *  (null when not applicable), `done`/`total` count SUCCESS stages vs all
 *  stages. Returns null on any HTTP/parse failure so the board can degrade
 *  (omit the stage line) rather than break. */
export interface StageInfo {
  current: string | null;
  failed: string | null;
  done: number;
  total: number;
}

const TREE =
  'builds[number,result,timestamp,duration,building,displayName,estimatedDuration,url,' +
  'actions[parameters[name,value],causes[userId,userName]]]{0,25}';

export async function fetchJobBuilds(
  cfg: ConsoleConfig['jenkins'], jobUrl: string, fetchImpl: typeof fetch = fetch
): Promise<JenkinsBuild[]> {
  const clean = jobUrl.replace(/\/+$/, '');
  const jobName = clean.split('/').pop() ?? clean;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.username && cfg.apiToken)
    headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.apiToken}`).toString('base64')}`;
  const res = await fetchImpl(`${clean}/api/json?tree=${TREE}`, { headers });
  if (!res.ok) throw new Error(`jenkins ${jobName}: HTTP ${res.status}`);
  const data = (await res.json()) as { builds?: Array<Record<string, unknown>> };
  return (data.builds ?? []).map((b) => {
    const actions = (b.actions ?? []) as Array<{ parameters?: Array<{ name: string; value: unknown }>;
                                                 causes?: Array<{ userId?: string }> }>;
    const params: Record<string, string> = {};
    for (const a of actions) for (const p of a.parameters ?? []) params[p.name] = String(p.value ?? '');
    const buildUser = actions.flatMap((a) => a.causes ?? []).find((c) => c.userId)?.userId ?? null;
    return {
      jobName, number: b.number as number, building: !!b.building,
      result: (b.result as string | null) ?? null,
      timestamp: b.timestamp as number, duration: b.duration as number,
      estimatedDuration: b.estimatedDuration as number,
      url: b.url as string, displayName: b.displayName as string, params, buildUser,
    };
  });
}

/** GET `${buildUrl}wfapi/describe` and reduce it to a `StageInfo` — the
 *  board's stage line. `buildUrl` is absolute and already ends with `/`
 *  (Jenkins' own `url` field); double slashes (e.g. a trailing `//`) are
 *  normalized before the request. Any HTTP/parse failure yields `null` —
 *  the caller (poller.ts) just omits the stage line, never blocks the board. */
export async function fetchBuildStages(
  cfg: ConsoleConfig['jenkins'], buildUrl: string, fetchImpl: typeof fetch = fetch
): Promise<StageInfo | null> {
  const base = buildUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.username && cfg.apiToken)
    headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.apiToken}`).toString('base64')}`;
  try {
    const res = await fetchImpl(`${base}/wfapi/describe`, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as { stages?: Array<{ name: string; status: string }> };
    const stages = data.stages ?? [];
    const current = stages.find((s) => s.status === 'IN_PROGRESS')?.name ?? null;
    const failed = stages.find((s) => s.status === 'FAILED')?.name ?? null;
    const done = stages.filter((s) => s.status === 'SUCCESS').length;
    return { current, failed, done, total: stages.length };
  } catch {
    return null;
  }
}
