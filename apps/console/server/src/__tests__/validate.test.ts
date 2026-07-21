import { describe, expect, it } from 'vitest';
import { normalizeRunBody } from '../validate.js';

const ALLOW = ['https://report-with-elastic-data.apps.ocptbox.tzla.sahibindenlocal.net'];
const GOOD_URL =
  'https://report-with-elastic-data.apps.ocptbox.tzla.sahibindenlocal.net/web-test-s4-flaky/2127?buildStartTime=1784553554830&fullTestBuildName=2026.07.20-16%3A19-ngn-qa-webautomation-web-test-s4-flaky-2127';

describe('normalizeRunBody (triage)', () => {
  it('accepts a valid triage body', () => {
    const r = normalizeRunBody(
      { projectPath: '/tmp/web-test', targetUrl: GOOD_URL, testbox: 'tb161', permissionPolicy: 'confirm-applies' },
      ALLOW
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.mode).toBe('triage');
      expect(r.value.testbox).toBe('tb161');
      expect(r.value.permissionPolicy).toBe('confirm-applies');
    }
  });
  it('rejects a report URL whose host is not allowlisted', () => {
    const r = normalizeRunBody(
      { projectPath: '/tmp/x', targetUrl: 'https://evil.example.com/a?fullTestBuildName=x&buildStartTime=1', testbox: 'tb1' },
      ALLOW
    );
    expect(r.ok).toBe(false);
  });
  it('rejects a malformed testbox', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', targetUrl: GOOD_URL, testbox: 'tb; rm -rf /' }, ALLOW);
    expect(r.ok).toBe(false);
  });
  it('rejects a URL missing fullTestBuildName', () => {
    const r = normalizeRunBody(
      { projectPath: '/tmp/x', targetUrl: ALLOW[0] + '/job/1?buildStartTime=1', testbox: 'tb1' },
      ALLOW
    );
    expect(r.ok).toBe(false);
  });
});
