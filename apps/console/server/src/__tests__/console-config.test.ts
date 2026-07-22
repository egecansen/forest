import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importDefaults, kitAllowlist, loadConsoleConfig } from '../console-config.js';

let tmp: string;
const mkTmp = async () => (tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hcfg-')));
afterEach(async () => { delete process.env.HEKTOR_CONSOLE_HOME; if (tmp) await fs.rm(tmp, { recursive: true, force: true }); });

describe('console-config', () => {
  it('loads config.json from HEKTOR_CONSOLE_HOME', async () => {
    await mkTmp();
    process.env.HEKTOR_CONSOLE_HOME = tmp;
    await fs.writeFile(path.join(tmp, 'config.json'), JSON.stringify({
      repoPath: '/tmp/web-test', testbox: 'tb161',
      jenkins: { baseUrl: 'https://jenkins.example', jobUrls: ['https://jenkins.example/job/web-test-s4-flaky'] },
      es: { url: 'https://es.example', index: 'web-report' },
      reportBase: 'https://report.example', pollMs: 15000,
    }));
    const cfg = await loadConsoleConfig();
    expect(cfg.testbox).toBe('tb161');
    expect(cfg.jenkins.jobUrls).toHaveLength(1);
  });

  it('loads an optional selenoidUrl when present, and leaves it undefined when absent', async () => {
    await mkTmp();
    process.env.HEKTOR_CONSOLE_HOME = tmp;
    await fs.writeFile(path.join(tmp, 'config.json'), JSON.stringify({
      repoPath: '/tmp/web-test', testbox: 'tb161',
      jenkins: { baseUrl: 'https://jenkins.example', jobUrls: ['https://jenkins.example/job/web-test-s4-flaky'] },
      es: { url: 'https://es.example', index: 'web-report' },
      reportBase: 'https://report.example', pollMs: 15000,
      selenoidUrl: 'https://selenoid.example/ui/#/sessions',
    }));
    const cfg = await loadConsoleConfig();
    expect(cfg.selenoidUrl).toBe('https://selenoid.example/ui/#/sessions');
  });

  it('imports jenkins + es from a quickly config.json', async () => {
    await mkTmp();
    const q = path.join(tmp, 'quickly.json');
    await fs.writeFile(q, JSON.stringify({
      jenkins: { baseUrl: 'https://jenkins.example', jobs: [{ url: 'https://jenkins.example/job/web-test-s4-flaky' }] },
      elasticsearch: { url: 'https://es.example', index: 'web-report', username: 'u', password: 'p' },
    }));
    const d = await importDefaults(q);
    expect(d.jenkins?.jobUrls).toEqual(['https://jenkins.example/job/web-test-s4-flaky']);
    expect(d.es?.username).toBe('u');
  });

  it('reads the kit host allowlist from the installed kit config', async () => {
    await mkTmp();
    const core = path.join(tmp, '.claude', 'skills', 'hektor-flaky-triage', 'core');
    await fs.mkdir(core, { recursive: true });
    await fs.writeFile(path.join(core, 'config.json'), JSON.stringify({ es: { host_allowlist: ['https://ok.example'] } }));
    expect(await kitAllowlist(tmp)).toEqual(['https://ok.example']);
  });
});
