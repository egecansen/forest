import type { ConsoleConfig } from '../console-config.js';

export interface JenkinsBuild {
  jobName: string; number: number; building: boolean; result: string | null;
  timestamp: number; duration: number; url: string; displayName: string;
  params: Record<string, string>; buildUser: string | null;
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
      url: b.url as string, displayName: b.displayName as string, params, buildUser,
    };
  });
}
