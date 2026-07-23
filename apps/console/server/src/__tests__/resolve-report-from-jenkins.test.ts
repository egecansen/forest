import { describe, expect, it, vi } from 'vitest';
import {
  resolveReportFromJenkins,
  fetchBuildTimestamp,
  isJenkinsBuildUrl,
} from '../resolve-report-from-jenkins.js';
import type { ConsoleConfig } from '../console-config.js';

const cfg: Pick<ConsoleConfig, 'jenkins' | 'es' | 'reportBase'> = {
  jenkins: {
    baseUrl: 'https://jenkins.ngntest.sahibindenlocal.net/qa',
    jobUrls: [],
    username: 'egecan.sen',
    apiToken: 'tok-123456',
  },
  es: { url: 'https://es.example', index: 'web-report', username: 'u', password: 'p' },
  reportBase: 'https://report.example',
};

const JENKINS_BUILD =
  'https://jenkins.ngntest.sahibindenlocal.net/qa/job/QA/job/webautomation/job/web-test-s4-tag/2256/';

const jenkinsMeta = (timestamp: number) => ({ ok: true, json: async () => ({ timestamp, number: 2256 }) });
const esName = (name: string | null) => ({
  ok: true,
  json: async () => ({ hits: { total: { value: 1 }, hits: name ? [{ _source: { testBuildName: name } }] : [] } }),
});

describe('isJenkinsBuildUrl', () => {
  it('matches on host', () => {
    expect(isJenkinsBuildUrl(cfg.jenkins.baseUrl, JENKINS_BUILD)).toBe(true);
    expect(isJenkinsBuildUrl(cfg.jenkins.baseUrl, 'https://report.example/web-test-s4-tag/2256')).toBe(false);
    expect(isJenkinsBuildUrl(cfg.jenkins.baseUrl, 'garbage')).toBe(false);
  });
});

describe('fetchBuildTimestamp', () => {
  it('sends Basic auth and returns the timestamp', async () => {
    const fetchImpl = vi.fn(async () => jenkinsMeta(1784715546735) as unknown as Response);
    const ts = await fetchBuildTimestamp(cfg.jenkins, JENKINS_BUILD, fetchImpl as unknown as typeof fetch);
    expect(ts).toBe(1784715546735);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/2256/api/json?tree=timestamp,number');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });
  it('returns null on HTTP failure (e.g. 403 unauthenticated)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);
    expect(await fetchBuildTimestamp(cfg.jenkins, JENKINS_BUILD, fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});

describe('resolveReportFromJenkins', () => {
  it('composes Jenkins build → s-report URL', async () => {
    const fetchImpl = vi.fn(async (u: string) =>
      (u.includes('/api/json')
        ? jenkinsMeta(1784715546735)
        : esName('2026.07.22-13:53-ngn-qa-webautomation-web-test-s4-tag-2256')) as unknown as Response
    );
    const r = await resolveReportFromJenkins(cfg, JENKINS_BUILD, fetchImpl as unknown as typeof fetch);
    expect(r).not.toBeNull();
    expect(r!.jobName).toBe('web-test-s4-tag');
    expect(r!.buildNumber).toBe(2256);
    const u = new URL(r!.targetUrl);
    expect(u.origin + u.pathname).toBe('https://report.example/web-test-s4-tag/2256');
    expect(u.searchParams.get('buildStartTime')).toBe('1784715546735');
    expect(u.searchParams.get('fullTestBuildName')).toBe('2026.07.22-13:53-ngn-qa-webautomation-web-test-s4-tag-2256');
  });
  it('returns null when Jenkins is unauthenticated (no timestamp)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);
    expect(await resolveReportFromJenkins(cfg, JENKINS_BUILD, fetchImpl as unknown as typeof fetch)).toBeNull();
  });
  it('returns null when ES has no doc for the build yet', async () => {
    const fetchImpl = vi.fn(async (u: string) =>
      (u.includes('/api/json') ? jenkinsMeta(1) : esName(null)) as unknown as Response
    );
    expect(await resolveReportFromJenkins(cfg, JENKINS_BUILD, fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});
