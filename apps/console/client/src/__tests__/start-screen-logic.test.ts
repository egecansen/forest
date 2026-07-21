import { describe, it, expect } from 'vitest';
import { isValidTestbox, isValidReportUrl } from '../components/StartScreen';

// Mirrors server/src/validate.ts's TB_RE = /^tb[0-9]{1,4}$/.
describe('isValidTestbox', () => {
  it('accepts tb + 1-4 digits', () => {
    expect(isValidTestbox('tb1')).toBe(true);
    expect(isValidTestbox('tb161')).toBe(true);
    expect(isValidTestbox('tb9999')).toBe(true);
  });
  it('rejects 5+ digits, missing digits, wrong prefix, or injection attempts', () => {
    expect(isValidTestbox('tb99999')).toBe(false);
    expect(isValidTestbox('tb')).toBe(false);
    expect(isValidTestbox('box161')).toBe(false);
    expect(isValidTestbox('tb; rm -rf /')).toBe(false);
    expect(isValidTestbox('')).toBe(false);
  });
  it('tolerates surrounding whitespace, same as the server trims before testing', () => {
    expect(isValidTestbox('  tb161  ')).toBe(true);
  });
});

// Mirrors server/src/validate.ts's URL-parses + has-fullTestBuildName checks
// (the server additionally checks the host allowlist + buildStartTime, which
// need server-side config and get a proper error from POST /api/runs — this
// is a client-side *quick* check, not a full re-implementation).
describe('isValidReportUrl', () => {
  const GOOD = 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=abc';
  it('accepts a parseable URL carrying fullTestBuildName', () => {
    expect(isValidReportUrl(GOOD)).toBe(true);
  });
  it('rejects an unparseable string', () => {
    expect(isValidReportUrl('not a url')).toBe(false);
    expect(isValidReportUrl('')).toBe(false);
    expect(isValidReportUrl('https://')).toBe(false);
  });
  it('rejects a well-formed URL missing fullTestBuildName', () => {
    expect(isValidReportUrl('https://report.example/x?buildStartTime=1')).toBe(false);
  });
});
