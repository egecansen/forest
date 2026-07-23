import type { ConsoleConfig } from './console-config.js';
import { fetchBuildFailInfo, sReportUrl } from './trackers/es.js';
import { parseReportUrl } from './resolve-run-testbox.js';

/**
 * Turn a Jenkins build URL into the s-report `targetUrl` the triage pipeline
 * already consumes — so an operator can paste
 * `…/job/web-test-s4-tag/2256/` instead of hand-building the report URL.
 *
 * Composition (all server-side; Jenkins uses the existing `username:apiToken`):
 *   parse job/build  →  Jenkins /api/json `timestamp` (= buildStartTime)
 *                    →  ES exact `fullTestBuildName` (must not be reconstructed)
 *                    →  sReportUrl(...)
 * Returns null when any step can't resolve (unauthenticated Jenkins, no ES doc).
 */
export interface JenkinsReportResolution {
  targetUrl: string;
  jobName: string;
  buildNumber: number;
  buildStartTime: number;
  fullTestBuildName: string;
}

/** A Jenkins build URL's start timestamp (ms) via `/api/json` (token auth). */
export async function fetchBuildTimestamp(
  jenkins: ConsoleConfig['jenkins'],
  buildUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<number | null> {
  const base = buildUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (jenkins.username && jenkins.apiToken)
    headers.Authorization = `Basic ${Buffer.from(`${jenkins.username}:${jenkins.apiToken}`).toString('base64')}`;
  try {
    const res = await fetchImpl(`${base}/api/json?tree=timestamp,number`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { timestamp?: number };
    return typeof data.timestamp === 'number' && data.timestamp > 0 ? data.timestamp : null;
  } catch {
    return null;
  }
}

export async function resolveReportFromJenkins(
  cfg: Pick<ConsoleConfig, 'jenkins' | 'es' | 'reportBase'>,
  buildUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<JenkinsReportResolution | null> {
  // A Jenkins build URL ends in `.../<jobName>/<buildNumber>` — the same tail
  // shape as an s-report URL, so parseReportUrl handles both.
  const parsed = parseReportUrl(buildUrl);
  if (!parsed) return null;
  const { jobName, buildNumber } = parsed;

  const buildStartTime = await fetchBuildTimestamp(cfg.jenkins, buildUrl, fetchImpl);
  if (buildStartTime === null) return null;

  const { testBuildName } = await fetchBuildFailInfo(cfg.es, jobName, buildNumber, fetchImpl);
  if (!testBuildName) return null;

  const targetUrl = sReportUrl(cfg.reportBase, jobName, buildNumber, buildStartTime, testBuildName);
  return { targetUrl, jobName, buildNumber, buildStartTime, fullTestBuildName: testBuildName };
}

/** True when the URL points at the configured Jenkins host (vs already an
 *  s-report URL). Lets a single "resolve" endpoint accept either. */
export function isJenkinsBuildUrl(jenkinsBaseUrl: string, candidate: string): boolean {
  try {
    return new URL(candidate).host === new URL(jenkinsBaseUrl).host;
  } catch {
    return false;
  }
}
