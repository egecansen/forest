import { describe, it, expect } from 'vitest';
import { buildRedactList, makeRedactor } from '../redact.js';
import type { ConsoleConfig } from '../console-config.js';

const cfg = (overrides: Partial<ConsoleConfig> = {}): ConsoleConfig => ({
  repoPath: '/tmp/repo',
  testbox: 'tb161',
  jenkins: { baseUrl: 'https://jenkins.example', jobUrls: [] },
  es: { url: 'https://es.example', index: 'web-report' },
  reportBase: 'https://report.example',
  pollMs: 15000,
  ...overrides,
});

describe('buildRedactList', () => {
  it('collects jenkins.apiToken and es.password', () => {
    const list = buildRedactList(
      cfg({
        jenkins: { baseUrl: 'https://jenkins.example', jobUrls: [], apiToken: 'sekret-token-123' },
        es: { url: 'https://es.example', index: 'web-report', password: 'hunter2pass' },
      })
    );
    expect(list).toEqual(expect.arrayContaining(['sekret-token-123', 'hunter2pass']));
    expect(list).toHaveLength(2);
  });

  it('excludes values shorter than 5 characters', () => {
    const list = buildRedactList(
      cfg({
        jenkins: { baseUrl: 'https://jenkins.example', jobUrls: [], apiToken: 'ab' },
        es: { url: 'https://es.example', index: 'web-report', password: 'xy' },
      })
    );
    expect(list).toEqual([]);
  });

  it('returns an empty list when secrets are absent', () => {
    expect(buildRedactList(cfg())).toEqual([]);
  });

  it('returns an empty list for a null config', () => {
    expect(buildRedactList(null)).toEqual([]);
  });
});

describe('makeRedactor', () => {
  it('replaces a single occurrence with the redacted placeholder', () => {
    const redactor = makeRedactor(['sekret-token-123']);
    expect(redactor('the token is sekret-token-123 in the log')).toBe(
      'the token is «redacted» in the log'
    );
  });

  it('replaces multiple occurrences of the same secret', () => {
    const redactor = makeRedactor(['sekret']);
    expect(redactor('sekret then sekret again')).toBe('«redacted» then «redacted» again');
  });

  it('redacts longest-first so a shorter secret does not partially mask a longer one', () => {
    // 'sekret' is a substring of 'sekret-extended' — if the short one were
    // replaced first, the longer secret's remaining "-extended" suffix would
    // leak into the log unredacted.
    const redactor = makeRedactor(['sekret', 'sekret-extended']);
    expect(redactor('value: sekret-extended')).toBe('value: «redacted»');
  });

  it('passes undefined through unchanged', () => {
    const redactor = makeRedactor(['sekret']);
    expect(redactor(undefined)).toBeUndefined();
  });

  it('is a safe no-op identity when the list is empty', () => {
    const redactor = makeRedactor([]);
    expect(redactor('nothing to redact here')).toBe('nothing to redact here');
    expect(redactor(undefined)).toBeUndefined();
  });

  it('treats secrets as literal text, not regex', () => {
    // A regex-unsafe secret (contains characters that are regex metachars)
    // must still be matched literally via split/join.
    const redactor = makeRedactor(['a.b*c(d)']);
    expect(redactor('token=a.b*c(d) end')).toBe('token=«redacted» end');
  });
});
