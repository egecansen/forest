import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ConsoleConfig {
  repoPath: string;
  testbox: string;
  jenkins: { baseUrl: string; jobUrls: string[]; username?: string; apiToken?: string };
  es: { url: string; index: string; username?: string; password?: string };
  reportBase: string;
  pollMs: number;
  /** Selenoid session-grid URL — a live link, not a secret; shown in the run
   *  console header while a run is live so the operator can jump straight to
   *  the browser session. Optional: unset when the console isn't wired up
   *  to a Selenoid grid. */
  selenoidUrl?: string;
}

const home = () => process.env.HEKTOR_CONSOLE_HOME ?? path.join(os.homedir(), '.hektor-console');
export const configPath = () => path.join(home(), 'config.json');

/** Loads and minimally validates the console config. Throws with a helpful
 *  message when missing — index.ts catches it and serves /api/builds as 503
 *  until the user creates the file (first-run flow, Task 7). */
export async function loadConsoleConfig(): Promise<ConsoleConfig> {
  const raw = await fs.readFile(configPath(), 'utf8');
  const c = JSON.parse(raw) as ConsoleConfig;
  for (const k of ['repoPath', 'testbox', 'reportBase'] as const)
    if (typeof c[k] !== 'string' || !c[k]) throw new Error(`config.json: "${k}" is required`);
  if (!c.jenkins?.baseUrl || !Array.isArray(c.jenkins.jobUrls)) throw new Error('config.json: jenkins.{baseUrl,jobUrls} required');
  if (!c.es?.url || !c.es.index) throw new Error('config.json: es.{url,index} required');
  c.pollMs = typeof c.pollMs === 'number' && c.pollMs >= 5000 ? c.pollMs : 15000;
  return c;
}

/** Best-effort import of Jenkins/ES settings from quickly's config.json. */
export async function importDefaults(quicklyConfigPath: string): Promise<Partial<ConsoleConfig>> {
  try {
    const q = JSON.parse(await fs.readFile(quicklyConfigPath, 'utf8')) as {
      jenkins?: { baseUrl?: string; jobs?: Array<{ url?: string }> };
      elasticsearch?: { url?: string; index?: string; username?: string; password?: string };
    };
    const out: Partial<ConsoleConfig> = {};
    if (q.jenkins?.baseUrl) {
      out.jenkins = {
        baseUrl: q.jenkins.baseUrl,
        jobUrls: (q.jenkins.jobs ?? []).map((j) => j.url).filter((u): u is string => !!u),
      };
    }
    if (q.elasticsearch?.url && q.elasticsearch.index) {
      out.es = { url: q.elasticsearch.url, index: q.elasticsearch.index,
                 username: q.elasticsearch.username, password: q.elasticsearch.password };
    }
    return out;
  } catch {
    return {};
  }
}

/** The kit's SSRF seam: es.host_allowlist from the kit installed in `repoPath`. */
export async function kitAllowlist(repoPath: string): Promise<string[]> {
  const p = path.join(repoPath, '.claude', 'skills', 'hektor-flaky-triage', 'core', 'config.json');
  const cfg = JSON.parse(await fs.readFile(p, 'utf8')) as { es?: { host_allowlist?: string[] } };
  return cfg.es?.host_allowlist ?? [];
}
