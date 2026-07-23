import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ConsoleConfig {
  repoPath: string;
  testbox: string;
  jenkins: { baseUrl: string; jobUrls: string[]; username?: string; apiToken?: string };
  es: { url: string; index: string; username?: string; password?: string };
  /** Optional SRP (testbox reservation) wiring. `baseUrl` is the gateway root
   *  the SRP SPA calls; `cookie` is the operator's SRP session (a secret,
   *  redacted like the Jenkins token). Absent → SHBDN- runs fall back to a
   *  user-provided box (no auto-detect / reserve). */
  srp?: { baseUrl: string; cookie?: string; username?: string };
  reportBase: string;
  pollMs: number;
  /** Selenoid session-grid URL — a live link, not a secret; shown in the run
   *  console header while a run is live so the operator can jump straight to
   *  the browser session. Optional: unset when the console isn't wired up
   *  to a Selenoid grid. Used only as a fallback when no live URL has been
   *  detected in the run's own output — see `selenoidUrlPattern` below. */
  selenoidUrl?: string;
  /** JS-regex SOURCE (no slashes/flags) matched, case-insensitively, against
   *  live tool-result text to detect the actual per-run Selenoid live-session
   *  URL (driver.ts) — the real URL is dynamic per rerun, unlike the static
   *  `selenoidUrl` above. Server-side detection knob only; never echoed to
   *  the client. Optional: falls back to `DEFAULT_SELENOID_URL_PATTERN` when
   *  absent, or when the configured source is not a valid regex. */
  selenoidUrlPattern?: string;
}

/** Matches a Selenoid grid URL (host contains "selenoid") or a generic
 *  Selenium-grid session-viewer URL (`.../#/sessions/<id>`). The `\S` runs
 *  are bounded (`{0,300}`/`{1,300}`, not unbounded `\S*`/`\S+`) so that even
 *  a "matching-prefix" pathological input — one that DOES contain a literal
 *  the driver's cheap pre-check can't skip (see extractSelenoidUrl in
 *  driver.ts) — can't make this alternation backtrack unboundedly; 300 chars
 *  is far more than any real Selenoid/session URL needs. */
export const DEFAULT_SELENOID_URL_PATTERN =
  '(https?://\\S{0,300}selenoid\\S{0,300}|https?://\\S{1,300}/#/sessions/\\S{1,300})';

/**
 * Builds the RegExp driver.ts uses to detect a Selenoid live-session URL in
 * tool-result text. Always case-insensitive. `pattern` is the operator's
 * optional `ConsoleConfig.selenoidUrlPattern`; when absent, or when it isn't
 * a valid regex source, falls back to `DEFAULT_SELENOID_URL_PATTERN` — a bad
 * config value degrades detection, it never crashes the console. Invalid
 * configured patterns log a warning so a typo doesn't fail silently forever.
 */
export function buildSelenoidUrlRegex(pattern?: string): RegExp {
  if (pattern) {
    try {
      return new RegExp(pattern, 'i');
    } catch (e) {
      console.warn(
        `[hektor-console] invalid selenoidUrlPattern (${(e as Error).message}) — using default`
      );
    }
  }
  return new RegExp(DEFAULT_SELENOID_URL_PATTERN, 'i');
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
