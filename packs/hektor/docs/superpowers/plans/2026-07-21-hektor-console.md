# Hektor Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local GUI for the flaky-triage-kit — builds board (Jenkins + ES), one-click triage sessions driven by a headless Claude agent, live tracking with cluster pick / approvals in the browser.

**Architecture:** Fork sahika's `client/` + `server/` into `apps/console/` (this repo). Replace the simulator behind `startDriver(run, queryFn, {resume})` with a Claude Agent SDK session that runs the kit's SKILL loop inside the web-test repo; `canUseTool` bridges `AskUserQuestion` to the browser via the inherited `pending-answers` module; an in-process SDK MCP server (`hektor-console`) lets the agent publish the clusters table and per-cluster status. New: trackers (Jenkins/ES) + `/api/builds` + Builds board screen.

**Tech Stack:** Node 20+, TypeScript, Express + ws, React + Vite, vitest, `@anthropic-ai/claude-agent-sdk`, `zod` (server). No other new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-20-hektor-console-design.md`

## Global Constraints

- Fork source: `/Users/egecan.sen/sahibinden/repo/sahika` (read-only — NEVER modify sahika).
- The kit (`kits/flaky-triage-kit`, and its install at `<repo>/.claude/skills/hektor-flaky-triage/`) is NEVER modified.
- Server binds `127.0.0.1` only; keep sahika's `host-guard` + all path-traversal sandboxes intact.
- App state root: `~/.hektor-console/` (override via env `HEKTOR_CONSOLE_HOME` — required for tests). Secrets live only there, never in git.
- Report/pasted URLs must be validated against the kit's `core/config.json` `es.host_allowlist` before a run starts.
- Branding: `hektor` (replaces `şahika`/`sahika` in UI copy); CSS design system inherited unchanged.
- **Commit messages: NO AI-attribution trailers** (`Co-Authored-By: Claude…`, "Generated with…", claude.ai/code URLs) — a repo hook rejects them.
- Tests: vitest, colocated under `src/__tests__/` following sahika's existing layout. Run server tests with `npm --prefix server test`, client with `npm --prefix client test` (from `apps/console`).
- TypeScript strict; plain `.js` extensions on relative imports in server code (NodeNext, matches sahika).

## File Structure

```
apps/console/
├─ package.json                      # root scripts (fork, rename)
├─ client/src/
│  ├─ types.ts                       # MODIFY: triage PhaseId, Cluster, RunConfig
│  ├─ phases.ts                      # REWRITE: 6 triage phases
│  ├─ App.tsx                        # MODIFY: builds-board view + ?triage= deep link
│  ├─ components/BuildsBoard.tsx     # NEW: builds board screen
│  ├─ components/ClustersTab.tsx     # NEW: clusters table + convergence chips (replaces FindingsTab usage)
│  ├─ components/StartScreen.tsx     # REWRITE: triage form (report URL, testbox, repo, policy)
│  └─ components/RunConsole.tsx      # MODIFY: tab list (drop Journeys/Recording, add Clusters)
└─ server/src/
   ├─ types.ts                       # MODIFY: triage PhaseId, Cluster, ClusterState, events, RunConfig
   ├─ validate.ts                    # REWRITE: triage run body + allowlist check
   ├─ console-config.ts              # NEW: ~/.hektor-console/config.json + quickly/kit import
   ├─ trackers/jenkins.ts            # NEW: fetch builds from Jenkins API
   ├─ trackers/es.ts                 # NEW: failed counts + testBuildName → s-report URL
   ├─ trackers/poller.ts             # NEW: cached polling gated on connected clients
   ├─ run-store.ts                   # MODIFY: clusters on Run (setClusters/updateCluster)
   ├─ driver.ts                      # REWRITE: real Agent SDK driver (queryFn seam kept)
   ├─ driver-prompt.ts               # NEW: buildPrompt(config)
   ├─ driver-can-use-tool.ts         # NEW: makeCanUseTool(run, policy) — AskUserQuestion bridge
   ├─ driver-mcp.ts                  # NEW: hektor-console MCP server (set_clusters, cluster_status)
   ├─ notify.ts                      # NEW: macOS notifications (osascript)
   ├─ index.ts                       # MODIFY: /api/builds route, notify subscription, remove QA-only bits
   └─ simulator.ts                   # DELETE (fixtures move into driver tests)
```

Interfaces that recur across tasks (single source of truth — server `types.ts`, mirrored to client `types.ts`):

```ts
export type PhaseId = 'ingest' | 'cluster' | 'pick' | 'fix' | 'verify' | 'report';
export const PHASE_ORDER: PhaseId[] = ['ingest', 'cluster', 'pick', 'fix', 'verify', 'report'];

export type ClusterBucket = 'easy-fix' | 'selector' | 'vrt' | 'app-change' | 'infra' | 'likely-bug';
export type ClusterState =
  | 'proposed' | 'picked' | 'skipped' | 'fixing' | 'verifying' | 'green' | 'app-bug' | 'error';

export interface Cluster {
  id: string;            // agent-chosen slug, e.g. "onetrust-overlay"
  title: string;         // one-line cause, human phrasing
  bucket: ClusterBucket;
  tests: string[];       // FQCNs or test names
  state: ClusterState;
  passes?: number;       // green-proof progress: passes so far
  runs?: number;         // green-proof target N
  note?: string;         // short status detail ("fixed selector, verifying")
}

export interface RunConfig {
  projectPath: string;                 // web-test repo (agent cwd)
  targetUrl: string;                   // the s-report URL (kept name: shell renders it)
  testbox: string;                     // e.g. "tb161"
  mode: 'triage';
  permissionPolicy: 'autonomous' | 'confirm-applies';
  projectMode?: 'new' | 'continue';
  runId: string;
  demo?: boolean;
}

// ServerEvent additions:
//  | { type: 'clusters'; clusters: Cluster[] }
//  | { type: 'cluster'; cluster: Cluster }
```

```ts
// driver.ts — the seam (kept from sahika, now typed):
export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) =>
  AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<void> };
export type DriverHandle = (() => void) & { pause: () => void };
export function startDriver(run: Run, queryFn?: QueryFn, opts?: { resume?: boolean }): DriverHandle;
```

---

### Task 1: Fork the sahika shell into `apps/console`

**Files:**
- Create: `apps/console/**` (copy of sahika `client/`, `server/`, root `package.json`, tsconfigs)
- Modify: `apps/console/server/src/persistence.ts` (state root), `apps/console/package.json` (name)

**Interfaces:**
- Consumes: sahika repo at `/Users/egecan.sen/sahibinden/repo/sahika`
- Produces: a building, test-passing copy under `apps/console` with state root `~/.hektor-console` (env-overridable). Everything later builds on this tree.

- [ ] **Step 1: Copy the tree (excluding build artifacts and VCS)**

```bash
cd /Users/egecan.sen/sahibinden/repo/SKLS/hektor
mkdir -p apps/console
rsync -a --exclude node_modules --exclude dist --exclude .git --exclude .achilles --exclude .DS_Store \
  /Users/egecan.sen/sahibinden/repo/sahika/ apps/console/
```

- [ ] **Step 2: Rename package + state root**

In `apps/console/package.json` set `"name": "hektor-console"`. In `apps/console/server/package.json` set `"name": "hektor-console-server"`; in `apps/console/client/package.json` set `"name": "hektor-console-client"`.

In `apps/console/server/src/persistence.ts` replace the root constant with an env-overridable one:

```ts
export const DEFAULT_ROOT = process.env.HEKTOR_CONSOLE_HOME ?? path.join(os.homedir(), '.hektor-console');
```

- [ ] **Step 3: Install + run both test suites to establish the green baseline**

```bash
cd apps/console && npm run install:all
npm --prefix server test
npm --prefix client test
```

Expected: PASS (same suites that pass in sahika). If a test hardcodes `.sahika-gui`, update it to use `HEKTOR_CONSOLE_HOME` + a temp dir.

- [ ] **Step 4: Rebrand visible copy (mechanical)**

```bash
cd apps/console
grep -rl 'şahika\|sahika-gui\|sahika' client/src server/src --include='*.ts' --include='*.tsx' --include='*.css' --include='*.html'
```

Replace user-visible strings: `şahika` → `hektor`, log prefix `[sahika-gui]` → `[hektor-console]`, `client/index.html` `<title>` → `hektor`. Do NOT touch CSS class names.

- [ ] **Step 5: Build + commit**

```bash
npm run build   # from apps/console — both halves compile
cd /Users/egecan.sen/sahibinden/repo/SKLS/hektor
git add apps/console && git commit -m "console: fork sahika shell as hektor-console"
```

---

### Task 2: Re-type the shell for triage

**Files:**
- Modify: `apps/console/server/src/types.ts`, `apps/console/client/src/types.ts`
- Rewrite: `apps/console/client/src/phases.ts`, `apps/console/server/src/validate.ts`
- Modify (compile-green sweep): `client/src/components/StartScreen.tsx`, `RunConsole.tsx`, `TimelineTab.tsx`, `Sidebar.tsx`, `server/src/index.ts`, `server/src/simulator.ts` (temporary shim), tests
- Test: `apps/console/server/src/__tests__/validate.test.ts`

**Interfaces:**
- Produces: the shared types from the File Structure section (`PhaseId`, `Cluster`, `ClusterState`, `RunConfig`, `ServerEvent` additions, `PHASE_ORDER`) — every later task imports these; `normalizeRunBody(body, allowlist)` with the new signature.

- [ ] **Step 1: Write the failing validate test**

`server/src/__tests__/validate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it — must fail** (`npm --prefix server test -- validate`) with signature/shape errors.

- [ ] **Step 3: Apply the type changes**

`server/src/types.ts` — replace `PhaseId`/`PHASE_ORDER` with the triage set; add `ClusterBucket`/`ClusterState`/`Cluster` exactly as in File Structure; replace `RunConfig` with the triage shape (keep `demo`, drop `runMode`/`record`/credential fields — also drop them from `RunSnapshot`-adjacent code); delete `Journey`/`Recording` types and their `ServerEvent` arms; add the two cluster event arms; add `clusters: Cluster[]` to `RunSnapshot`. Mirror all of it into `client/src/types.ts` (keep `PhaseDescriptor`).

`client/src/phases.ts` — rewrite:

```ts
import type { PhaseDescriptor } from './types';

export const PHASES: PhaseDescriptor[] = [
  { id: 'ingest',  number: 1, label: 'Ingest',  short: 'Phase 1 · Ingest',  description: 'pin the build, pull FAILED docs from the report' },
  { id: 'cluster', number: 2, label: 'Cluster', short: 'Phase 2 · Cluster', description: 'root-cause clusters, easy-fix → likely-bug' },
  { id: 'pick',    number: 3, label: 'Pick',    short: 'Phase 3 · Pick',    description: 'one decision: which clusters to take' },
  { id: 'fix',     number: 4, label: 'Fix',     short: 'Phase 4 · Fix',     description: 'apply + compile-check the picked clusters' },
  { id: 'verify',  number: 5, label: 'Verify',  short: 'Phase 5 · Verify',  description: 'green-proof pass^N on the testbox' },
  { id: 'report',  number: 6, label: 'Report',  short: 'Phase 6 · Report',  description: 'convergence scoreboard' },
];
export const phaseById = (id: string) => PHASES.find((p) => p.id === id);
```

(Delete `MODE_LABEL` / `usesPipeline`; triage always uses the pipeline — fix call sites to pass `true`.)

`server/src/validate.ts` — rewrite:

```ts
import path from 'node:path';
import type { RunConfig } from './types.js';

type Result = { ok: true; value: Omit<RunConfig, 'runId'> } | { ok: false; error: string };

const TB_RE = /^tb[0-9]{1,4}$/;

/** Parses + validates a triage run body. `allowlist` = kit es.host_allowlist. */
export function normalizeRunBody(body: unknown, allowlist: string[]): Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.projectPath !== 'string' || !b.projectPath.trim()) return { ok: false, error: 'projectPath is required' };
  if (typeof b.targetUrl !== 'string' || !b.targetUrl.trim()) return { ok: false, error: 'report URL is required' };
  if (typeof b.testbox !== 'string' || !TB_RE.test(b.testbox.trim())) return { ok: false, error: 'testbox must look like tb161' };

  let u: URL;
  try { u = new URL(b.targetUrl.trim()); } catch { return { ok: false, error: 'report URL is not a valid URL' }; }
  if (!allowlist.includes(u.origin)) return { ok: false, error: `report host not allowlisted: ${u.origin}` };
  if (!u.searchParams.get('fullTestBuildName')) return { ok: false, error: 'report URL missing fullTestBuildName' };
  if (!/^[0-9]+$/.test(u.searchParams.get('buildStartTime') ?? '')) return { ok: false, error: 'report URL missing/invalid buildStartTime' };

  return {
    ok: true,
    value: {
      projectPath: path.resolve(b.projectPath.trim()),
      targetUrl: u.toString(),
      testbox: b.testbox.trim(),
      mode: 'triage',
      permissionPolicy: b.permissionPolicy === 'autonomous' ? 'autonomous' : 'confirm-applies',
      projectMode: b.projectMode === 'continue' ? 'continue' : 'new',
      demo: b.demo === true,
    },
  };
}
```

- [ ] **Step 4: Compile-green sweep**

Run `npm run build`; fix every error mechanically, with these dispositions:
- `index.ts`: `normalizeRunBody(req.body)` → `normalizeRunBody(req.body, allowlist)` — for now pass a module-level `const allowlist = ['https://report-with-elastic-data.apps.ocptbox.tzla.sahibindenlocal.net']` with a `// TODO(task3): read from kit config` marker replaced in Task 3. Delete the secret/`RunSecret` plumbing (`runStore.create(parsed.value)`), the `/report`-deck, recordings, journeys and auth-login routes and their imports (`recordings.ts`, `auth-login.ts`, `auth-status.ts`, `project-state.ts` can be deleted). Keep `/api/health`, `/api/browse`, runs/stop/pause/resume/answer, `/api/runs`, `/api/runs/:id`, `/api/runs/:runId/file`, history, static, WS.
- `run-store.ts`: delete `RunSecret`/redaction plumbing (`secret`, `redactList`, `extractSecretTokens`, `redact()` become no-ops — keep the method as identity to minimize churn), `addJourney`, `flagApproverNudge`/`consumeApproverNudge`, `seedPrior*` (project-continuation seeding is QA-pipeline specific). Initialize `clusters: []` in the snapshot.
- `simulator.ts`: replace its body with a minimal triage-shaped walk (used by `demo: true` and tests until Task 9 deletes it): set phases ingest→cluster active/done with a few `run.log` lines, then `run.finish(true)`.
- Client: `StartScreen.tsx` — strip mode/runMode/credential/record UI down to: project path (+ browse), report URL, testbox, policy select (`confirm-applies` default), start button (full triage form styling comes in Task 12; here it only needs to compile and post the new body). `RunConsole.tsx` — remove Journeys/Recording/Findings tabs and `NowPlaying`/`RecordingTab`/`JourneysTab`/`FindingsTab` imports (ClustersTab arrives in Task 12; temporarily keep Log/Timeline/Files/Report). `TimelineTab.tsx`/`Sidebar.tsx` — drop `usesPipeline` conditionals (always pipeline). Delete dead component files.
- Tests referencing deleted features (journeys, recordings, auth, credentials, redaction, seedPrior): delete those test files; keep persistence/pending-answers/host-guard/run-store basics.

- [ ] **Step 5: Run all tests — PASS.** `npm --prefix server test && npm --prefix client test`

- [ ] **Step 6: Commit** — `git add -A apps/console && git commit -m "console: re-type shell for triage (phases, clusters, run config)"`

---

### Task 3: Console config (`~/.hektor-console/config.json` + import)

**Files:**
- Create: `apps/console/server/src/console-config.ts`
- Test: `apps/console/server/src/__tests__/console-config.test.ts`
- Modify: `apps/console/server/src/index.ts` (allowlist + config load at startup)

**Interfaces:**
- Produces:
  ```ts
  export interface ConsoleConfig {
    repoPath: string;                       // web-test repo (agent cwd)
    testbox: string;                        // default tb
    jenkins: { baseUrl: string; jobUrls: string[]; username?: string; apiToken?: string };
    es: { url: string; index: string; username?: string; password?: string };
    reportBase: string;                     // s-report site origin
    pollMs: number;                         // builds poll interval (default 15000)
  }
  export function loadConsoleConfig(): Promise<ConsoleConfig>;      // reads $HEKTOR_CONSOLE_HOME/config.json
  export function importDefaults(quicklyConfigPath: string): Promise<Partial<ConsoleConfig>>;
  export function kitAllowlist(repoPath: string): Promise<string[]>; // reads <repo>/.claude/skills/hektor-flaky-triage/core/config.json
  ```

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run — FAIL** (module not found).

- [ ] **Step 3: Implement `console-config.ts`**

```ts
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
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Wire into `index.ts`**

At startup: `const consoleConfig = await loadConsoleConfig().catch((e) => { console.warn('[hektor-console] no config:', e.message); return null; })` (make the bootstrap async — wrap listen in `main()`), and `const allowlist = consoleConfig ? await kitAllowlist(consoleConfig.repoPath).catch(() => []) : []`. Replace Task 2's hardcoded allowlist. Add `GET /api/config` returning `{ configured: !!consoleConfig, repoPath, testbox, reportBase }` (no secrets), 200 always.

- [ ] **Step 6: Tests + build PASS, commit** — `console: config file with quickly/kit import`

---

### Task 4: Jenkins tracker

**Files:**
- Create: `apps/console/server/src/trackers/jenkins.ts`
- Test: `apps/console/server/src/__tests__/jenkins-tracker.test.ts`

**Interfaces:**
- Consumes: `ConsoleConfig['jenkins']` (Task 3)
- Produces:
  ```ts
  export interface JenkinsBuild {
    jobName: string; number: number; building: boolean;
    result: string | null;              // SUCCESS | FAILURE | UNSTABLE | ABORTED | null while building
    timestamp: number; duration: number; url: string; displayName: string;
    params: Record<string, string>;     // e.g. TAG, JIRA_TICKET
    buildUser: string | null;
  }
  export function fetchJobBuilds(cfg: ConsoleConfig['jenkins'], jobUrl: string,
    fetchImpl?: typeof fetch): Promise<JenkinsBuild[]>;
  ```

- [ ] **Step 1: Failing test with a recorded-shape fixture**

```ts
import { describe, expect, it, vi } from 'vitest';
import { fetchJobBuilds } from '../trackers/jenkins.js';

const FIXTURE = {
  builds: [{
    number: 2127, result: 'FAILURE', timestamp: 1784553554830, duration: 5400000, building: false,
    displayName: '#2127', estimatedDuration: 5000000,
    url: 'https://jenkins.example/job/web-test-s4-flaky/2127/',
    actions: [
      { parameters: [{ name: 'TAG', value: 'Bireysel' }, { name: 'JIRA_TICKET', value: 'CI-123' }] },
      { causes: [{ userId: 'egecan.sen', userName: 'Egecan Sen' }] },
    ],
  }, {
    number: 2128, result: null, timestamp: 1784560000000, duration: 0, building: true,
    displayName: '#2128', estimatedDuration: 5000000,
    url: 'https://jenkins.example/job/web-test-s4-flaky/2128/', actions: [],
  }],
};

describe('jenkins tracker', () => {
  it('fetches + flattens builds with params and user', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(FIXTURE), { status: 200 })) as unknown as typeof fetch;
    const builds = await fetchJobBuilds({ baseUrl: 'https://jenkins.example', jobUrls: [] },
      'https://jenkins.example/job/web-test-s4-flaky', fetchImpl);
    expect(builds).toHaveLength(2);
    expect(builds[0]).toMatchObject({ jobName: 'web-test-s4-flaky', number: 2127, result: 'FAILURE',
      params: { TAG: 'Bireysel', JIRA_TICKET: 'CI-123' }, buildUser: 'egecan.sen' });
    expect(builds[1].building).toBe(true);
    const calledUrl = (fetchImpl as unknown as { mock: { calls: [[string]] } }).mock.calls[0][0];
    expect(calledUrl).toContain('/api/json?tree=builds[');
  });

  it('sends basic auth when apiToken configured', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ builds: [] }), { status: 200 })) as unknown as typeof fetch;
    await fetchJobBuilds({ baseUrl: 'https://jenkins.example', jobUrls: [], username: 'u', apiToken: 't' },
      'https://jenkins.example/job/x', fetchImpl);
    const init = (fetchImpl as unknown as { mock: { calls: [[string, RequestInit]] } }).mock.calls[0][1];
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('throws on HTTP error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchJobBuilds({ baseUrl: 'x', jobUrls: [] }, 'https://jenkins.example/job/x', fetchImpl)).rejects.toThrow('503');
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `trackers/jenkins.ts`**

```ts
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
```

- [ ] **Step 4: Run — PASS. Commit** — `console: jenkins builds tracker`

---

### Task 5: ES tracker + s-report URL construction

**Files:**
- Create: `apps/console/server/src/trackers/es.ts`
- Test: `apps/console/server/src/__tests__/es-tracker.test.ts`

**Interfaces:**
- Consumes: `ConsoleConfig['es']`, `ConsoleConfig['reportBase']`
- Produces:
  ```ts
  export function fetchBuildFailInfo(es: ConsoleConfig['es'], jobName: string, buildNumber: number,
    fetchImpl?: typeof fetch): Promise<{ failedCount: number; testBuildName: string | null }>;
  export function sReportUrl(reportBase: string, jobName: string, buildNumber: number,
    buildStartTime: number, fullTestBuildName: string): string;
  ```

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { fetchBuildFailInfo, sReportUrl } from '../trackers/es.js';

const ES = { url: 'https://es.example', index: 'web-report' };
const HIT = { _source: { testBuildName: '2026.07.20-16:19-ngn-qa-webautomation-web-test-s4-flaky-2127' } };
const RESP = { hits: { total: { value: 12 }, hits: [HIT] } };

describe('es tracker', () => {
  it('returns failed count + exact testBuildName in one query', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(RESP), { status: 200 })) as unknown as typeof fetch;
    const info = await fetchBuildFailInfo(ES, 'web-test-s4-flaky', 2127, fetchImpl);
    expect(info).toEqual({ failedCount: 12, testBuildName: HIT._source.testBuildName });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [[string, RequestInit]] } }).mock.calls[0];
    expect(url).toBe('https://es.example/web-report/_search');
    const body = JSON.parse(init.body as string);
    expect(JSON.stringify(body.query)).toContain('*web-test-s4-flaky-2127');
    expect(JSON.stringify(body.query)).toContain('FAILED');
  });

  it('returns zero/null on ES failure (never throws — board degrades)', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect(await fetchBuildFailInfo(ES, 'j', 1, fetchImpl)).toEqual({ failedCount: 0, testBuildName: null });
  });

  it('constructs the s-report URL the kit ingests', () => {
    const u = sReportUrl('https://report.example', 'web-test-s4-flaky', 2127, 1784553554830,
      '2026.07.20-16:19-ngn-qa-webautomation-web-test-s4-flaky-2127');
    expect(u).toBe('https://report.example/web-test-s4-flaky/2127?buildStartTime=1784553554830&fullTestBuildName=2026.07.20-16%3A19-ngn-qa-webautomation-web-test-s4-flaky-2127');
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `trackers/es.ts`**

```ts
import type { ConsoleConfig } from '../console-config.js';

/** One query serves both board needs: FAILED hit total for the build, and one
 *  sample doc's exact `testBuildName` (needed for the s-report URL — it carries
 *  a datetime prefix we must not reconstruct locally). Total on failure. */
export async function fetchBuildFailInfo(
  es: ConsoleConfig['es'], jobName: string, buildNumber: number, fetchImpl: typeof fetch = fetch
): Promise<{ failedCount: number; testBuildName: string | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (es.username && es.password)
    headers.Authorization = `Basic ${Buffer.from(`${es.username}:${es.password}`).toString('base64')}`;
  const body = {
    size: 1,
    _source: ['testBuildName'],
    query: { bool: { must: [
      { wildcard: { 'testBuildName.keyword': `*${jobName}-${buildNumber}` } },
      { term: { 'testStatus.keyword': 'FAILED' } },
    ] } },
    track_total_hits: true,
  };
  try {
    const res = await fetchImpl(`${es.url}/${es.index}/_search`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      hits?: { total?: { value?: number } | number; hits?: Array<{ _source?: { testBuildName?: string } }> };
    };
    const t = data.hits?.total;
    const failedCount = typeof t === 'number' ? t : t?.value ?? 0;
    return { failedCount, testBuildName: data.hits?.hits?.[0]?._source?.testBuildName ?? null };
  } catch {
    return { failedCount: 0, testBuildName: null };
  }
}

export function sReportUrl(
  reportBase: string, jobName: string, buildNumber: number, buildStartTime: number, fullTestBuildName: string
): string {
  const u = new URL(`${reportBase.replace(/\/+$/, '')}/${jobName}/${buildNumber}`);
  u.searchParams.set('buildStartTime', String(buildStartTime));
  u.searchParams.set('fullTestBuildName', fullTestBuildName);
  return u.toString();
}
```

- [ ] **Step 4: Run — PASS. Commit** — `console: ES fail-count tracker + s-report URL`

---

### Task 6: Builds poller + `/api/builds`

**Files:**
- Create: `apps/console/server/src/trackers/poller.ts`
- Modify: `apps/console/server/src/index.ts`
- Test: `apps/console/server/src/__tests__/poller.test.ts`

**Interfaces:**
- Consumes: `fetchJobBuilds` (Task 4), `fetchBuildFailInfo`/`sReportUrl` (Task 5), `loadConsoleConfig` (Task 3)
- Produces:
  ```ts
  export interface BuildRow extends JenkinsBuild { failedCount: number; reportUrl: string | null; }
  export class BuildsPoller {
    constructor(cfg: ConsoleConfig, fetchImpl?: typeof fetch);
    setClientCount(n: number): void;                    // polls only while > 0
    getBuilds(): { builds: BuildRow[]; fetchedAt: number | null; stale: boolean };
    refreshNow(): Promise<void>;                        // one poll cycle (also what the timer calls)
    stop(): void;
  }
  ```
  Route: `GET /api/builds` → `503 {error}` when unconfigured, else `{ builds, fetchedAt, stale }`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { BuildsPoller } from '../trackers/poller.js';
import type { ConsoleConfig } from '../console-config.js';

const CFG: ConsoleConfig = {
  repoPath: '/tmp/web-test', testbox: 'tb161',
  jenkins: { baseUrl: 'https://jenkins.example', jobUrls: ['https://jenkins.example/job/web-test-s4-flaky'] },
  es: { url: 'https://es.example', index: 'web-report' },
  reportBase: 'https://report.example', pollMs: 15000,
};

const jenkinsResp = { builds: [{ number: 2127, result: 'FAILURE', timestamp: 1784553554830, duration: 1, building: false,
  displayName: '#2127', estimatedDuration: 1, url: 'https://jenkins.example/job/web-test-s4-flaky/2127/', actions: [] }] };
const esResp = { hits: { total: { value: 12 }, hits: [{ _source: { testBuildName: 'x-web-test-s4-flaky-2127' } }] } };

const fetchImpl = vi.fn(async (url: string) =>
  new Response(JSON.stringify(String(url).includes('_search') ? esResp : jenkinsResp), { status: 200 })
) as unknown as typeof fetch;

describe('BuildsPoller', () => {
  it('assembles BuildRows with failedCount + reportUrl on refresh', async () => {
    const p = new BuildsPoller(CFG, fetchImpl);
    await p.refreshNow();
    const { builds, stale } = p.getBuilds();
    expect(stale).toBe(false);
    expect(builds[0]).toMatchObject({ number: 2127, failedCount: 12 });
    expect(builds[0].reportUrl).toContain('/web-test-s4-flaky/2127?buildStartTime=1784553554830');
    p.stop();
  });

  it('caches ES info for finished builds (no second _search for same build)', async () => {
    (fetchImpl as unknown as { mockClear: () => void }).mockClear();
    const p = new BuildsPoller(CFG, fetchImpl);
    await p.refreshNow();
    await p.refreshNow();
    const esCalls = (fetchImpl as unknown as { mock: { calls: [[string]] } }).mock.calls
      .filter(([u]) => String(u).includes('_search'));
    expect(esCalls).toHaveLength(1);
    p.stop();
  });

  it('keeps last data and marks stale when jenkins fails', async () => {
    let fail = false;
    const f = vi.fn(async (url: string) => fail && !String(url).includes('_search')
      ? new Response('x', { status: 500 })
      : new Response(JSON.stringify(String(url).includes('_search') ? esResp : jenkinsResp), { status: 200 })
    ) as unknown as typeof fetch;
    const p = new BuildsPoller(CFG, f);
    await p.refreshNow();
    fail = true;
    await p.refreshNow();
    const { builds, stale } = p.getBuilds();
    expect(builds).toHaveLength(1);   // last good data kept
    expect(stale).toBe(true);
    p.stop();
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `trackers/poller.ts`**

```ts
import type { ConsoleConfig } from '../console-config.js';
import { fetchJobBuilds, type JenkinsBuild } from './jenkins.js';
import { fetchBuildFailInfo, sReportUrl } from './es.js';

export interface BuildRow extends JenkinsBuild { failedCount: number; reportUrl: string | null; }

export class BuildsPoller {
  private builds: BuildRow[] = [];
  private fetchedAt: number | null = null;
  private stale = false;
  private clients = 0;
  private timer: NodeJS.Timeout | null = null;
  /** Finished builds' ES info never changes — cache by jobName#number. */
  private esCache = new Map<string, { failedCount: number; reportUrl: string | null }>();

  constructor(private cfg: ConsoleConfig, private fetchImpl: typeof fetch = fetch) {}

  setClientCount(n: number) {
    this.clients = n;
    if (n > 0 && !this.timer) {
      this.timer = setInterval(() => void this.refreshNow(), this.cfg.pollMs);
      void this.refreshNow();
    } else if (n === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getBuilds() { return { builds: this.builds, fetchedAt: this.fetchedAt, stale: this.stale }; }

  async refreshNow(): Promise<void> {
    try {
      const arrays = await Promise.all(
        this.cfg.jenkins.jobUrls.map((u) => fetchJobBuilds(this.cfg.jenkins, u, this.fetchImpl))
      );
      const all = arrays.flat().sort((a, b) => b.timestamp - a.timestamp).slice(0, 25);
      this.builds = await Promise.all(all.map(async (b) => {
        const key = `${b.jobName}#${b.number}`;
        let es = !b.building ? this.esCache.get(key) : undefined;
        if (!es) {
          const info = await fetchBuildFailInfo(this.cfg.es, b.jobName, b.number, this.fetchImpl);
          es = {
            failedCount: info.failedCount,
            reportUrl: info.testBuildName
              ? sReportUrl(this.cfg.reportBase, b.jobName, b.number, b.timestamp, info.testBuildName)
              : null,
          };
          if (!b.building && info.testBuildName) this.esCache.set(key, es);
        }
        return { ...b, ...es };
      }));
      this.fetchedAt = Date.now();
      this.stale = false;
    } catch {
      this.stale = true;  // keep last data — the board degrades, never blanks
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Wire route + client-count gating in `index.ts`**

```ts
const poller = consoleConfig ? new BuildsPoller(consoleConfig) : null;

app.get('/api/builds', (_req, res) => {
  if (!poller) { res.status(503).json({ error: 'console not configured — create ~/.hektor-console/config.json' }); return; }
  res.json(poller.getBuilds());
});
```

In the WS upgrade handler, also accept `pathname === '/ws-board'` (no runId): register the socket in a `boardClients` set, `poller?.setClientCount(boardClients.size)` on open and close. The board client connects this socket as a presence signal + gets `{type:'builds'}` pushes. For the pushes, give `BuildsPoller` an assignable property (NOT a constructor change — the Step 1 tests stay valid):

```ts
/** Set by index.ts; called at the end of every successful/failed refreshNow(). */
onRefresh: ((data: ReturnType<BuildsPoller['getBuilds']>) => void) | null = null;
// …at the end of refreshNow(), in both the try and catch paths:
this.onRefresh?.(this.getBuilds());
```

`index.ts`: `poller.onRefresh = (data) => { for (const ws of boardClients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'builds', ...data })); };`

- [ ] **Step 6: Build + tests PASS. Commit** — `console: builds poller + /api/builds + board WS`

---

### Task 7: Builds board UI + deep link

**Files:**
- Create: `apps/console/client/src/components/BuildsBoard.tsx`
- Modify: `apps/console/client/src/App.tsx`
- Test: `apps/console/client/src/__tests__/builds-board.test.tsx`

**Interfaces:**
- Consumes: `GET /api/builds` + `/ws-board` (Task 6), `GET /api/config` (Task 3)
- Produces: `<BuildsBoard onTriage={(reportUrl: string) => void} />`; App view `{ kind: 'board' }` is the landing view; `?triage=<url>` deep link prefills + jumps to the start form.

- [ ] **Step 1: Failing component test** (follow the existing client test setup/pattern in `client/src/__tests__`)

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuildsBoard } from '../components/BuildsBoard';

const ROWS = { fetchedAt: Date.now(), stale: false, builds: [
  { jobName: 'web-test-s4-flaky', number: 2127, building: false, result: 'FAILURE', timestamp: Date.now(),
    duration: 1, url: 'https://jenkins.example/job/web-test-s4-flaky/2127/', displayName: '#2127',
    params: { TAG: 'Bireysel' }, buildUser: 'egecan.sen', failedCount: 12,
    reportUrl: 'https://report.example/web-test-s4-flaky/2127?buildStartTime=1&fullTestBuildName=x' },
  { jobName: 'web-test-s4-flaky', number: 2128, building: true, result: null, timestamp: Date.now(),
    duration: 0, url: 'https://jenkins.example/job/web-test-s4-flaky/2128/', displayName: '#2128',
    params: {}, buildUser: null, failedCount: 0, reportUrl: null },
] };

describe('BuildsBoard', () => {
  it('renders rows; Triage enabled only for red builds with a report', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ROWS), { status: 200 })));
    const onTriage = vi.fn();
    render(<BuildsBoard onTriage={onTriage} />);
    await waitFor(() => expect(screen.getByText('#2127')).toBeInTheDocument());
    const buttons = screen.getAllByRole('button', { name: /triage/i });
    const rowBtn = buttons.find((b) => !b.textContent?.includes('latest'))!;
    await userEvent.click(rowBtn);
    expect(onTriage).toHaveBeenCalledWith(ROWS.builds[0].reportUrl);
  });

  it('"Triage latest" picks the newest red build with a report', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ROWS), { status: 200 })));
    const onTriage = vi.fn();
    render(<BuildsBoard onTriage={onTriage} />);
    await waitFor(() => expect(screen.getByText('#2127')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /triage latest/i }));
    expect(onTriage).toHaveBeenCalledWith(ROWS.builds[0].reportUrl);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `BuildsBoard.tsx`** — one screen, styled with existing design-system classes (`start-screen`/`start-card` frame, table rows in mono):

```tsx
import { useEffect, useMemo, useState } from 'react';

interface BuildRow {
  jobName: string; number: number; building: boolean; result: string | null;
  timestamp: number; duration: number; url: string; displayName: string;
  params: Record<string, string>; buildUser: string | null;
  failedCount: number; reportUrl: string | null;
}
interface BoardData { builds: BuildRow[]; fetchedAt: number | null; stale: boolean }

const isRed = (b: BuildRow) => !b.building && (b.result === 'FAILURE' || b.result === 'UNSTABLE');

export function BuildsBoard({ onTriage }: { onTriage: (reportUrl: string) => void }) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [pasted, setPasted] = useState('');

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    (async () => {
      try {
        const res = await fetch('/api/builds');
        if (!res.ok) { setError((await res.json()).error ?? `HTTP ${res.status}`); return; }
        setData(await res.json());
        ws = new WebSocket(`ws://${location.host}/ws-board`);
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'builds' && !closed) setData(msg);
        };
      } catch { setError('server unreachable'); }
    })();
    return () => { closed = true; ws?.close(); };
  }, []);

  const rows = useMemo(() => (data?.builds ?? [])
    .filter((b) => !tagFilter || (b.params.TAG ?? '').toLowerCase().includes(tagFilter.toLowerCase()))
    .filter((b) => !mineOnly || !!b.buildUser), [data, tagFilter, mineOnly]);
  const latestRed = rows.find((b) => isRed(b) && b.reportUrl);

  if (error) return <div className="start-screen"><div className="start-card"><p className="field-note">{error}</p></div></div>;

  return (
    <div className="start-screen">
      <div className="start-card builds-board">
        <div className="board-header">
          <h1 className="brand">hektor</h1>
          <span className="field-note">flaky triage — latest builds{data?.stale ? ' · stale' : ''}</span>
          <button type="button" className="btn btn-primary" disabled={!latestRed}
            onClick={() => latestRed?.reportUrl && onTriage(latestRed.reportUrl)}>
            triage latest
          </button>
        </div>
        <div className="board-filters">
          <input placeholder="filter TAG" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} />
          <label><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> only mine</label>
        </div>
        <table className="board-table">
          <tbody>
            {rows.map((b) => (
              <tr key={`${b.jobName}-${b.number}`} className={isRed(b) ? 'is-red' : b.building ? 'is-running' : ''}>
                <td>{b.displayName}</td>
                <td>{b.building ? 'RUNNING' : b.result}</td>
                <td>{b.params.TAG ?? ''}</td>
                <td>{b.buildUser ?? ''}</td>
                <td>{b.failedCount > 0 ? `${b.failedCount} failed` : ''}</td>
                <td><a href={b.url} target="_blank" rel="noreferrer">jenkins</a></td>
                <td>{b.reportUrl && <a href={b.reportUrl} target="_blank" rel="noreferrer">report</a>}</td>
                <td>
                  <button type="button" className="btn" disabled={!isRed(b) || !b.reportUrl}
                    onClick={() => b.reportUrl && onTriage(b.reportUrl)}>triage</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="board-paste">
          <input placeholder="…or paste an s-report URL" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button type="button" className="btn" disabled={!pasted.trim()} onClick={() => onTriage(pasted.trim())}>triage url</button>
        </div>
      </div>
    </div>
  );
}
```

Add minimal styles to `styles/global.css` for `.builds-board`, `.board-table`, `.is-red` (yellow-accent row highlight), reusing existing variables.

- [ ] **Step 4: Wire into `App.tsx`**

Add view kind `'board'` as the initial view; `'start'` becomes the triage form reached from the board:

```tsx
type View =
  | { kind: 'board' }
  | { kind: 'start'; prefillReportUrl?: string }
  | { kind: 'console'; config: RunConfig }
  | { kind: 'history'; runId: string; snapshot: RunSnapshot };

const [view, setView] = useState<View>(() => {
  const deep = new URLSearchParams(location.search).get('triage');
  return deep ? { kind: 'start', prefillReportUrl: deep } : { kind: 'board' };
});
```

Render `{view.kind === 'board' && <BuildsBoard onTriage={(url) => setView({ kind: 'start', prefillReportUrl: url })} />}` and pass `prefillReportUrl` into `StartScreen`. "new run" returns to `{ kind: 'board' }`.

- [ ] **Step 5: Triaged-build chips (spec: board doubles as history-at-a-glance)**

In `BuildsBoard`, fetch `/api/history` once on mount; build a map from each summary's `targetUrl` → `{status}`. A row whose `reportUrl` appears in the map renders a small chip in the actions cell: `triaged · completed` / `triaged · failed` (class `board-chip`). Assertion added to the Step 1 suite:

```tsx
// added to the first test, after stubbing fetch to also answer /api/history:
// [{ runId: 'r1', projectPath: '/x', targetUrl: ROWS.builds[0].reportUrl, mode: 'triage',
//    status: 'completed', startedAt: 1, findings: 0, tests: 0 }]
expect(screen.getByText(/triaged · completed/)).toBeInTheDocument();
```

- [ ] **Step 6: Client tests + build PASS. Commit** — `console: builds board + deep link`

---

### Task 8: Cluster state on `Run`

**Files:**
- Modify: `apps/console/server/src/run-store.ts`
- Test: `apps/console/server/src/__tests__/run-clusters.test.ts`

**Interfaces:**
- Consumes: `Cluster`, cluster `ServerEvent` arms (Task 2)
- Produces:
  ```ts
  Run.setClusters(clusters: Cluster[]): void            // replaces the table, emits {type:'clusters'}
  Run.updateCluster(id: string, patch: Partial<Cluster>): void  // merge + emit {type:'cluster'}
  ```

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { runStore } from '../run-store.js';
import type { Cluster, ServerEvent } from '../types.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };
const CL: Cluster = { id: 'onetrust', title: 'OneTrust overlay intercepts clicks', bucket: 'easy-fix',
  tests: ['com.x.FooTest'], state: 'proposed' };

describe('Run cluster state', () => {
  it('setClusters replaces + emits, updateCluster merges + emits', () => {
    const run = runStore.create(cfg);
    const events: ServerEvent[] = [];
    run.on('event', (e: ServerEvent) => events.push(e));
    run.setClusters([CL]);
    expect(run.snapshot.clusters).toHaveLength(1);
    run.updateCluster('onetrust', { state: 'verifying', passes: 2, runs: 3 });
    expect(run.snapshot.clusters[0]).toMatchObject({ state: 'verifying', passes: 2 });
    expect(events.some((e) => e.type === 'clusters')).toBe(true);
    expect(events.some((e) => e.type === 'cluster' && e.cluster.state === 'verifying')).toBe(true);
  });
  it('updateCluster on unknown id is a no-op', () => {
    const run = runStore.create(cfg);
    run.updateCluster('nope', { state: 'green' });
    expect(run.snapshot.clusters).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** on `Run` (next to `addFinding`):

```ts
setClusters(clusters: Cluster[]) {
  this.snapshot.clusters = clusters;
  this.emitEvent({ type: 'clusters', clusters });
}

updateCluster(id: string, patch: Partial<Cluster>) {
  const idx = this.snapshot.clusters.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const merged = { ...this.snapshot.clusters[idx], ...patch, id };
  this.snapshot.clusters[idx] = merged;
  this.emitEvent({ type: 'cluster', cluster: merged });
}
```

- [ ] **Step 4: PASS. Commit** — `console: cluster state on Run`

---

### Task 9: Driver core — real Agent SDK session

**Files:**
- Rewrite: `apps/console/server/src/driver.ts`
- Create: `apps/console/server/src/driver-prompt.ts`
- Delete: `apps/console/server/src/simulator.ts` (move the `demo:true` path to a tiny scripted `QueryFn` in `driver.ts` tests / a `demoQueryFn` export)
- Test: `apps/console/server/src/__tests__/driver.test.ts`
- Modify: `apps/console/server/package.json` (add `@anthropic-ai/claude-agent-sdk`, `zod`)

**Interfaces:**
- Consumes: `Run` (+ Task 8 methods), `QueryFn`/`DriverHandle` seam
- Produces: `startDriver(run, queryFn?, opts?)` — real driver; `buildPrompt(config: RunConfig, opts: { resume: boolean }): string`; `inferPhase(command: string): PhaseId | null` (exported for tests). Phase inference contract (used by tests and later tasks): `ingest.sh`→ingest, `cluster.sh`→cluster, `apply.sh|compile.sh`→fix, `rerun.sh`→verify, `summary.sh`→report; AskUserQuestion→pick (handled in Task 10).

- [ ] **Step 1: `npm --prefix server i @anthropic-ai/claude-agent-sdk zod`**

- [ ] **Step 2: Failing test — scripted QueryFn drives Run state**

```ts
import { describe, expect, it, vi } from 'vitest';
import { startDriver, inferPhase, type QueryFn } from '../driver.js';
import { runStore } from '../run-store.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };

const msg = (m: Record<string, unknown>) => m;
function scripted(messages: Record<string, unknown>[]): QueryFn {
  return () => {
    async function* gen() { for (const m of messages) yield m; }
    return Object.assign(gen(), { interrupt: vi.fn(async () => {}) });
  };
}

describe('driver core', () => {
  it('maps SDK stream → session id, phases, log, telemetry, finish', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'completed') r(); }));
    startDriver(run, scripted([
      msg({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'KIT=…; "$KIT/ingest.sh" "https://r.example/…" > fails.json' } },
      ] } }),
      msg({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: '"$KIT/cluster.sh" < fails.json' } },
      ] } }),
      msg({ type: 'result', subtype: 'success', total_cost_usd: 0.42, usage: { output_tokens: 1000 }, result: 'done' }),
    ]));
    await done;
    expect(run.snapshot.sessionId).toBe('sess-1');
    expect(run.snapshot.phases.find((p) => p.id === 'ingest')?.status).toBe('done');
    expect(run.snapshot.phases.find((p) => p.id === 'cluster')?.status).toBe('done');
    expect(run.snapshot.telemetry.costUsd).toBe(0.42);
    expect(run.snapshot.status).toBe('completed');
    expect(run.snapshot.log.some((l) => l.text.includes('ingest'))).toBe(true);
  });

  it('a result with subtype error → run failed', async () => {
    const run = runStore.create(cfg);
    const done = new Promise<void>((r) => run.on('event', (e) => { if (e.type === 'status' && e.status === 'failed') r(); }));
    startDriver(run, scripted([msg({ type: 'result', subtype: 'error_during_execution' })]));
    await done;
    expect(run.snapshot.status).toBe('failed');
  });

  it('inferPhase maps core scripts to phases', () => {
    expect(inferPhase('"$KIT/ingest.sh" url')).toBe('ingest');
    expect(inferPhase('bash core/rerun.sh a,b tb161')).toBe('verify');
    expect(inferPhase('"$KIT/apply.sh"')).toBe('fix');
    expect(inferPhase('"$KIT/compile.sh"')).toBe('fix');
    expect(inferPhase('"$KIT/summary.sh" < ledger.json')).toBe('report');
    expect(inferPhase('ls -la')).toBe(null);
  });
});
```

- [ ] **Step 3: Run — FAIL.** **Step 4: Implement.**

`driver-prompt.ts`:

```ts
import type { RunConfig } from './types.js';

/** The whole harness integration: the agent runs the kit's own SKILL loop; the
 *  console only redirects its user interaction + status reporting. */
export function buildPrompt(config: RunConfig, opts: { resume: boolean }): string {
  const policy = config.permissionPolicy === 'autonomous'
    ? 'Applies that match a known recipe in core/config.json may proceed without asking; ask before other applies only if genuinely uncertain (SKILL batching discipline still applies).'
    : 'Before the FIRST apply of each picked batch, ask one AskUserQuestion summarizing the planned diffs (one option per cluster: proceed / skip).';
  return [
    opts.resume ? 'Resume the in-progress flaky triage below from its last state (re-read ledger.json).' : '',
    `Use the hektor-flaky-triage skill to triage this flaky run end-to-end.`,
    `s-report URL: ${config.targetUrl}`,
    `testbox: ${config.testbox}`,
    '',
    'You are running under Hektor Console (a GUI) — there is no terminal user. Rules:',
    '- ALL user interaction goes through the AskUserQuestion tool (the console renders it). Never wait for free-text input.',
    '- After you build the meaning-bucket clusters table and BEFORE asking the pick, call mcp__hektor-console__set_clusters with the full table.',
    '- Ask the cluster pick as ONE AskUserQuestion (multiSelect: true, one option per cluster; option label = cluster id).',
    '- On every cluster state change (fixing / verifying pass n of N / green / app-bug / error) call mcp__hektor-console__cluster_status.',
    `- Apply policy: ${policy}`,
    '- Final scoreboard: emit it as your final message text (the console shows it as the report).',
  ].filter(Boolean).join('\n');
}
```

`driver.ts`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Run } from './run-store.js';
import type { PhaseId } from './types.js';
import { PHASE_ORDER } from './types.js';
import { buildPrompt } from './driver-prompt.js';
import { makeCanUseTool } from './driver-can-use-tool.js';
import { hektorMcpServer } from './driver-mcp.js';

export type QueryFn = (args: { prompt: string; options: Record<string, unknown> }) =>
  AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<void> };
export type DriverHandle = (() => void) & { pause: () => void };

const PHASE_BY_SCRIPT: Array<[RegExp, PhaseId]> = [
  [/ingest\.sh/, 'ingest'],
  [/cluster\.sh/, 'cluster'],
  [/(apply|compile)\.sh/, 'fix'],
  [/(rerun|dom-capture|dom-on-failure)\.sh/, 'verify'],
  [/summary\.sh/, 'report'],
];

export function inferPhase(command: string): PhaseId | null {
  for (const [re, id] of PHASE_BY_SCRIPT) if (re.test(command)) return id;
  return null;
}

/** Advance the pipeline: mark `next` active and every earlier phase done. */
function advancePhase(run: Run, next: PhaseId) {
  const order = PHASE_ORDER;
  const target = order.indexOf(next);
  for (let i = 0; i < order.length; i++) {
    const cur = run.snapshot.phases.find((p) => p.id === order[i])!;
    if (i < target && (cur.status === 'active' || cur.status === 'queued')) run.setPhase(order[i], 'done');
    if (i === target && cur.status !== 'active') run.setPhase(order[i], 'active');
  }
}

const realQueryFn: QueryFn = ({ prompt, options }) =>
  query({ prompt, options }) as ReturnType<QueryFn>;

export function startDriver(run: Run, queryFn: QueryFn = realQueryFn, opts: { resume?: boolean } = {}): DriverHandle {
  const config = run.snapshot.config!;
  const abort = new AbortController();
  let pausing = false;

  const options: Record<string, unknown> = {
    cwd: config.projectPath,
    abortController: abort,
    permissionMode: 'default',
    // Load the target repo's .claude settings: the kit's skill + its
    // self-protection PreToolUse gates apply to this session exactly as in a
    // terminal run. The kit stays the authority on its own safety.
    settingSources: ['project'],
    canUseTool: makeCanUseTool(run),
    mcpServers: { 'hektor-console': hektorMcpServer(run) },
    ...(opts.resume && run.snapshot.sessionId ? { resume: run.snapshot.sessionId } : {}),
  };

  const stream = queryFn({ prompt: buildPrompt(config, { resume: !!opts.resume }), options });

  void (async () => {
    run.setStatus(opts.resume ? 'running' : 'preparing');
    try {
      for await (const m of stream) {
        if (run.isStopped()) break;
        const type = m.type as string;
        if (type === 'system' && (m as { subtype?: string }).subtype === 'init') {
          run.setSessionId((m as { session_id: string }).session_id);
          run.setStatus('running');
          run.setTelemetry({ thinking: true });
        } else if (type === 'assistant') {
          const content = ((m as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? []);
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              run.log({ kind: 'info', text: (block.text as string).slice(0, 400) });
            } else if (block.type === 'tool_use') {
              const name = block.name as string;
              const input = (block.input ?? {}) as Record<string, unknown>;
              if (name === 'Bash' && typeof input.command === 'string') {
                const phase = inferPhase(input.command);
                if (phase) advancePhase(run, phase);
                run.log({ kind: 'bash', text: `Bash(${(input.command as string).slice(0, 160)})` });
              } else if (name === 'Edit' || name === 'Write') {
                const file = (input.file_path as string) ?? '';
                run.addFile({ path: file, kind: name === 'Write' ? 'created' : 'modified' });
                run.log({ kind: 'active', text: `${name} ${file}` }, { verb: name === 'Write' ? 'write' : 'edit', file });
              } else if (!name.startsWith('mcp__hektor-console')) {
                run.log({ kind: 'skill', text: name });
              }
            }
          }
        } else if (type === 'result') {
          const r = m as { subtype?: string; total_cost_usd?: number; usage?: { output_tokens?: number }; result?: string };
          if (typeof r.total_cost_usd === 'number') run.setTelemetry({ costUsd: r.total_cost_usd });
          if (typeof r.usage?.output_tokens === 'number') run.raiseTokens(r.usage.output_tokens);
          run.setTelemetry({ thinking: false });
          if (r.subtype === 'success') {
            advancePhase(run, 'report');
            run.setPhase('report', 'done');
            if (r.result) run.log({ kind: 'success', text: r.result.slice(0, 2000) });
            run.finish(true);
          } else if (pausing) {
            run.setStatus('paused');
          } else {
            run.log({ kind: 'error', text: `agent ended: ${r.subtype ?? 'unknown error'}` });
            run.finish(false);
          }
        }
      }
      // Stream ended without a result (abort/stop): leave status as set by stop()/pause.
      if (!run.isStopped() && run.snapshot.status === 'running' && !pausing) run.finish(false);
    } catch (err) {
      if (!run.isStopped()) {
        run.log({ kind: 'error', text: `driver error: ${(err as Error).message}` });
        if (pausing) run.setStatus('paused'); else run.finish(false);
      }
    }
  })();

  const stop = () => { abort.abort(); run.stop(); };
  return Object.assign(stop, {
    pause: () => { pausing = true; void stream.interrupt?.().catch(() => abort.abort()); },
  });
}
```

Note on `pause`: `run.setStatus('paused')` conflicts with `Run.stop()` semantics — pause must NOT call `run.stop()` (that cancels). The `pausing` flag routes the stream end to `'paused'` status instead, and `index.ts`'s existing `/resume` route calls `startDriver(run, undefined, { resume: true })`, which resumes via `snapshot.sessionId`. Also update `run-store.ts`: `Run.setStatus` currently only stamps telemetry — no change needed for `'paused'`.

`demoQueryFn` (exported from `driver.ts`, used when `config.demo === true` in `index.ts`): a scripted generator that walks the four messages from the driver test plus one AskUserQuestion round (gives the UI a demo path with no SDK/network).

- [ ] **Step 5: Run driver tests — PASS. Full suite + build PASS.**
  (Task 10 creates `driver-can-use-tool.ts`/`driver-mcp.ts`; for THIS task create them as minimal stubs: `makeCanUseTool = (run) => async () => ({ behavior: 'allow' as const })`, `hektorMcpServer = (run) => undefined` — replaced next task.)

- [ ] **Step 6: Commit** — `console: real Agent SDK driver core (stream mapping, phases, demo)`

---

### Task 10: Question bridge + hektor-console MCP tools

**Files:**
- Rewrite: `apps/console/server/src/driver-can-use-tool.ts`, `apps/console/server/src/driver-mcp.ts`
- Test: `apps/console/server/src/__tests__/driver-bridge.test.ts`

**Interfaces:**
- Consumes: `pendingAnswers` (inherited), `Run.setPendingQuestion/clearPendingQuestion` (inherited), `Run.setClusters/updateCluster` (Task 8), `advancePhase` behavior via `Run.setPhase`
- Produces:
  ```ts
  export function makeCanUseTool(run: Run):
    (toolName: string, input: Record<string, unknown>, opts: { signal?: AbortSignal }) =>
      Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }>;
  export function hektorMcpServer(run: Run): unknown;  // SDK McpServer config for options.mcpServers
  ```

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { makeCanUseTool } from '../driver-can-use-tool.js';
import { pendingAnswers } from '../pending-answers.js';
import { runStore } from '../run-store.js';

const cfg = { projectPath: '/tmp/x', targetUrl: 'https://r.example/j/1?buildStartTime=1&fullTestBuildName=x',
  testbox: 'tb161', mode: 'triage' as const, permissionPolicy: 'confirm-applies' as const };

describe('question bridge', () => {
  it('AskUserQuestion blocks on the operator answer, then allows with updatedInput', async () => {
    const run = runStore.create(cfg);
    const canUseTool = makeCanUseTool(run);
    const input = { questions: [{ question: 'Which clusters?', header: 'Pick', multiSelect: true,
      options: [{ label: 'onetrust' }, { label: 'vrt-drift' }] }] };
    const p = canUseTool('AskUserQuestion', input, {});
    // The run is now awaiting input with a pending question:
    await new Promise((r) => setTimeout(r, 0));
    const q = run.snapshot.pendingQuestion!;
    expect(run.snapshot.status).toBe('awaiting-input');
    expect(q.questions[0].options.map((o) => o.label)).toEqual(['onetrust', 'vrt-drift']);
    // Operator answers via the HTTP route's registry:
    pendingAnswers.resolve(run.snapshot.config!.runId, q.questionId, { 'Which clusters?': ['onetrust'] });
    const result = await p;
    expect(result.behavior).toBe('allow');
    if (result.behavior === 'allow')
      expect((result.updatedInput as { answers: unknown }).answers).toEqual({ 'Which clusters?': ['onetrust'] });
    expect(run.snapshot.pendingQuestion).toBeNull();
    expect(run.snapshot.phases.find((ph) => ph.id === 'pick')?.status).toBe('done');
  });

  it('a stopped run rejects the pending question → deny', async () => {
    const run = runStore.create(cfg);
    const canUseTool = makeCanUseTool(run);
    const p = canUseTool('AskUserQuestion', { questions: [{ question: 'q', header: 'h', multiSelect: false,
      options: [{ label: 'a' }] }] }, {});
    await new Promise((r) => setTimeout(r, 0));
    run.stop();  // rejectAll unblocks the bridge
    const result = await p;
    expect(result.behavior).toBe('deny');
  });

  it('non-question tools pass through', async () => {
    const run = runStore.create(cfg);
    const result = await makeCanUseTool(run)('Bash', { command: 'ls' }, {});
    expect(result.behavior).toBe('allow');
  });
});
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.**

`driver-can-use-tool.ts`:

```ts
import type { Run } from './run-store.js';
import type { QuestionSpec } from './types.js';
import { pendingAnswers } from './pending-answers.js';
import { notifyDecision } from './notify.js';

type CanUseToolResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * sahika's anticipated bridge, realized: AskUserQuestion never reaches a
 * terminal — the tool call is held here, the question is pushed to the browser
 * (Run.setPendingQuestion → WS → QuestionModal), and the operator's POSTed
 * answer resolves the held promise. The answers ride back on `updatedInput.answers`
 * exactly as the interactive harness fills them, so the tool result the agent
 * sees is indistinguishable from a terminal session. Everything else is allowed
 * untouched — the kit's own PreToolUse gates (settingSources:'project') remain
 * the enforcement layer.
 */
export function makeCanUseTool(run: Run) {
  return async (toolName: string, input: Record<string, unknown>, _opts: { signal?: AbortSignal }): Promise<CanUseToolResult> => {
    if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };

    const questions = (input.questions ?? []) as QuestionSpec[];
    const questionId = run.nextQuestionId();
    const runId = run.snapshot.config!.runId;
    const answerPromise = pendingAnswers.register(runId, questionId);
    run.setPendingQuestion({ questionId, questions });
    notifyDecision(`hektor needs a decision: ${questions[0]?.header ?? 'question'}`);
    // The 'pick' phase is exactly the AskUserQuestion wait for the cluster pick;
    // any later question also parks there harmlessly (phase already done).
    const pick = run.snapshot.phases.find((p) => p.id === 'pick');
    if (pick && pick.status === 'queued') run.setPhase('pick', 'active');
    try {
      const answers = await answerPromise;
      run.clearPendingQuestion();
      if (pick && pick.status === 'active') run.setPhase('pick', 'done');
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    } catch {
      // stop()/a newer question rejected this one
      return { behavior: 'deny', message: 'The run was stopped before the user answered.' };
    }
  };
}
```

(For this task, add to `notify.ts` a placeholder `export const notifyDecision = (_: string) => {};` — real implementation in Task 11.)

`driver-mcp.ts`:

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Run } from './run-store.js';
import type { Cluster } from './types.js';

const clusterShape = {
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().max(200),
  bucket: z.enum(['easy-fix', 'selector', 'vrt', 'app-change', 'infra', 'likely-bug']),
  tests: z.array(z.string().max(300)).max(60),
};

/** In-process MCP server the agent uses to feed the GUI's clusters board.
 *  Advisory-only surface: nothing here mutates anything but the Run snapshot. */
export function hektorMcpServer(run: Run) {
  return createSdkMcpServer({
    name: 'hektor-console',
    version: '1.0.0',
    tools: [
      tool('set_clusters', 'Publish the full clusters table to the console (call once, before asking the pick).',
        { clusters: z.array(z.object(clusterShape)).max(40) },
        async ({ clusters }) => {
          run.setClusters(clusters.map((c): Cluster => ({ ...c, state: 'proposed' })));
          return { content: [{ type: 'text', text: `ok — ${clusters.length} clusters shown` }] };
        }),
      tool('cluster_status', 'Update one cluster\'s live state on the console board.',
        { id: z.string(), state: z.enum(['picked', 'skipped', 'fixing', 'verifying', 'green', 'app-bug', 'error']),
          passes: z.number().int().min(0).optional(), runs: z.number().int().min(1).optional(),
          note: z.string().max(200).optional() },
        async ({ id, state, passes, runs, note }) => {
          run.updateCluster(id, { state, passes, runs, note });
          return { content: [{ type: 'text', text: 'ok' }] };
        }),
    ],
  });
}
```

- [ ] **Step 4: Run — PASS** (bridge tests + full suite). **Step 5: Commit** — `console: AskUserQuestion bridge + hektor-console MCP tools`

---

### Task 11: Notifications + run-event wiring

**Files:**
- Create: `apps/console/server/src/notify.ts` (real implementation)
- Modify: `apps/console/server/src/index.ts`
- Test: `apps/console/server/src/__tests__/notify.test.ts`

**Interfaces:**
- Produces: `notifyDecision(message: string): void`, `notifyTerminal(title: string, message: string): void` — macOS `osascript display notification`, no-op off-darwin and under `NODE_ENV=test`; `execImpl` injectable for tests.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { makeNotifier } from '../notify.js';

describe('notify', () => {
  it('shells out to osascript on darwin', () => {
    const exec = vi.fn();
    const n = makeNotifier('darwin', exec);
    n.decision('clusters ready');
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][0]).toBe('osascript');
    expect(exec.mock.calls[0][1].join(' ')).toContain('clusters ready');
  });
  it('no-ops elsewhere', () => {
    const exec = vi.fn();
    makeNotifier('linux', exec).decision('x');
    expect(exec).not.toHaveBeenCalled();
  });
  it('escapes double quotes out of the message', () => {
    const exec = vi.fn();
    makeNotifier('darwin', exec).decision('say "hi" \\');
    expect(exec.mock.calls[0][1].join(' ')).not.toContain('"hi"');
  });
});
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement `notify.ts`**

```ts
import { execFile } from 'node:child_process';

type ExecImpl = (cmd: string, args: string[]) => void;
const defaultExec: ExecImpl = (cmd, args) => { execFile(cmd, args, () => {}); };

export function makeNotifier(platform: NodeJS.Platform = process.platform, exec: ExecImpl = defaultExec) {
  const fire = (title: string, message: string) => {
    if (platform !== 'darwin' || process.env.NODE_ENV === 'test') return;
    // AppleScript string literal: strip backslashes/quotes rather than escape —
    // notification copy never needs them and this closes the injection seam.
    const clean = (s: string) => s.replace(/[\\"]/g, "'");
    exec('osascript', ['-e', `display notification "${clean(message)}" with title "${clean(title)}"`]);
  };
  return {
    decision: (message: string) => fire('hektor — decision needed', message),
    terminal: (title: string, message: string) => fire(title, message),
  };
}

const notifier = makeNotifier();
export const notifyDecision = notifier.decision;
export const notifyTerminal = notifier.terminal;
```

(Adjust the darwin test: pass `platform` explicitly and temporarily unset `NODE_ENV` inside the test via `vi.stubEnv('NODE_ENV', 'dev')`.)

- [ ] **Step 4: Wire terminal notifications in `index.ts`** — in the existing per-run `onEvent` subscription: on terminal status, `notifyTerminal('hektor — run finished', `${ev.status}: ${run.snapshot.clusters.filter(c => c.state === 'green').length} green / ${run.snapshot.clusters.filter(c => c.state === 'app-bug').length} app-bug`)`. Also swap `demo` runs to `startDriver(run, demoQueryFn)`.

- [ ] **Step 5: PASS + commit** — `console: desktop notifications`

---

### Task 12: Clusters tab + triage StartScreen

**Files:**
- Create: `apps/console/client/src/components/ClustersTab.tsx`
- Rewrite: `apps/console/client/src/components/StartScreen.tsx` (proper triage form)
- Modify: `apps/console/client/src/components/RunConsole.tsx`, `client/src/useRunStream.ts` (handle `clusters`/`cluster` events), `client/src/types.ts` (already typed in Task 2)
- Test: `apps/console/client/src/__tests__/clusters-tab.test.tsx`

**Interfaces:**
- Consumes: `Cluster` type, WS events `{type:'clusters'}`/`{type:'cluster'}`, snapshot `clusters`
- Produces: `<ClustersTab clusters={Cluster[]} />` rendered as a RunConsole tab (default tab once clusters exist); StartScreen posts the Task 2 body `{projectPath, targetUrl, testbox, permissionPolicy, projectMode}` with defaults prefilled from `GET /api/config`.

- [ ] **Step 1: Failing test**

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ClustersTab } from '../components/ClustersTab';
import type { Cluster } from '../types';

const CLUSTERS: Cluster[] = [
  { id: 'onetrust', title: 'OneTrust overlay intercepts clicks', bucket: 'easy-fix',
    tests: ['FooTest', 'BarTest'], state: 'verifying', passes: 2, runs: 3 },
  { id: 'gone-flag', title: 'Flag element removed from detail page', bucket: 'likely-bug',
    tests: ['BazTest'], state: 'app-bug', note: 'element gone in current DOM' },
];

describe('ClustersTab', () => {
  it('renders one row per cluster with bucket, tests, and state chip', () => {
    render(<ClustersTab clusters={CLUSTERS} />);
    expect(screen.getByText('OneTrust overlay intercepts clicks')).toBeInTheDocument();
    expect(screen.getByText(/verifying 2\/3/)).toBeInTheDocument();
    expect(screen.getByText(/app-bug/)).toBeInTheDocument();
    expect(screen.getByText(/2 tests/)).toBeInTheDocument();
  });
  it('shows an empty state before clustering', () => {
    render(<ClustersTab clusters={[]} />);
    expect(screen.getByText(/no clusters yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement `ClustersTab.tsx`**

```tsx
import type { Cluster } from '../types';

const CHIP: Record<Cluster['state'], string> = {
  proposed: '· proposed', picked: '◇ picked', skipped: '– skipped', fixing: '⚒ fixing',
  verifying: '', green: '✅ green', 'app-bug': '🐞 app-bug', error: '⚠ error',
};

export function ClustersTab({ clusters }: { clusters: Cluster[] }) {
  if (clusters.length === 0) return <p className="field-note">no clusters yet — they appear after the cluster phase</p>;
  return (
    <table className="clusters-table">
      <thead><tr><th>cluster</th><th>bucket</th><th>tests</th><th>state</th></tr></thead>
      <tbody>
        {clusters.map((c) => (
          <tr key={c.id} className={`cluster-${c.state}`}>
            <td><span className="cluster-id">{c.id}</span> {c.title}</td>
            <td>{c.bucket}</td>
            <td>{c.tests.length === 1 ? c.tests[0] : `${c.tests.length} tests`}</td>
            <td>
              {c.state === 'verifying' ? `verifying ${c.passes ?? 0}/${c.runs ?? '?'}` : CHIP[c.state]}
              {c.note ? <span className="field-note"> · {c.note}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

Add `.clusters-table` / `.cluster-green` / `.cluster-app-bug` styles reusing design-system variables (green/red row tint like the board).

- [ ] **Step 4: Wire the tab + stream events**

`useRunStream.ts`: in the WS event switch add
```ts
case 'clusters': setSnapshot((s) => ({ ...s, clusters: ev.clusters })); break;
case 'cluster': setSnapshot((s) => ({ ...s,
  clusters: s.clusters.map((c) => (c.id === ev.cluster.id ? ev.cluster : c)) })); break;
```
`RunConsole.tsx`: add a `Clusters` tab (badge = cluster count) between Log and Timeline; auto-switch to it when the first `clusters` event lands and no user tab choice was made yet.

- [ ] **Step 5: StartScreen final form** — fields: project path (browse, default from `/api/config` `repoPath`), report URL (prefilled from `prefillReportUrl` prop when arriving via board/deep-link), testbox (default from config), policy select (`confirm-applies` → "confirm applies" / `autonomous` → "auto-approve recipe fixes"), start button label `start triage`. Client-side quick validation mirrors `validate.ts` (tb regex, URL parse + must contain `fullTestBuildName`).

- [ ] **Step 6: Client tests + build PASS. Commit** — `console: clusters tab + triage start form`

---

### Task 13: End-to-end smoke + acceptance

**Files:**
- Create: `apps/console/e2e/smoke.spec.ts` (+ `apps/console/playwright.config.ts`, `npm i -D @playwright/test` at `apps/console` root)
- Create: `apps/console/README.md`

**Interfaces:**
- Consumes: everything above; `demoQueryFn` (Task 9) — the smoke run uses `demo: true`, no SDK/network/Jenkins needed.

- [ ] **Step 1: Playwright config** — `webServer`: `npm run build && npm start` with `HEKTOR_CONSOLE_HOME` pointed at a fixture dir containing a `config.json` (jenkins/es URLs pointing at `127.0.0.1:1` so the board renders its error/stale state harmlessly); `use.baseURL: 'http://localhost:8765'`.

- [ ] **Step 2: Write `smoke.spec.ts`**

```ts
import { expect, test } from '@playwright/test';

test('board → demo triage run → clusters → pick → completion', async ({ page }) => {
  await page.goto('/?triage=https://report-with-elastic-data.apps.ocptbox.tzla.sahibindenlocal.net/web-test-s4-flaky/2127?buildStartTime=1%26fullTestBuildName=demo');
  // Deep link lands on the start form, prefilled:
  await expect(page.getByDisplayValue(/web-test-s4-flaky\/2127/)).toBeVisible();
  await page.getByLabel(/project path/i).fill('/tmp/demo-project');
  await page.getByLabel(/testbox/i).fill('tb161');
  await page.getByRole('checkbox', { name: /demo/i }).check();   // demo toggle on the form (dev-only, hidden unless ?demo)
  await page.getByRole('button', { name: /start triage/i }).click();
  // Demo driver publishes clusters then asks the pick:
  await expect(page.getByText(/needs a decision/i)).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /onetrust/i }).click();
  await page.getByRole('button', { name: /send answer/i }).click();
  await expect(page.getByText(/✅|green/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/completed/i)).toBeVisible({ timeout: 15000 });
});
```

(Make `demoQueryFn` walk: init → set_clusters equivalent (`run.setClusters` directly in the demo fn) → AskUserQuestion → cluster_status green → result success. The demo checkbox renders only when `?demo` is in the query or the `?triage=` value contains `fullTestBuildName=demo`.)

- [ ] **Step 3: Run `npx playwright test` — PASS.**

- [ ] **Step 4: README** — how to run (`npm run install:all`, `npm run dev`), config file format with a copy-paste sample (repoPath, testbox, jenkins jobUrls + optional username/apiToken, es creds, reportBase), first-run import hint (`importDefaults` from `~/sahibinden/repo/quickly/config.json` — a `node -e` one-liner), deep-link format, and the acceptance checklist below.

- [ ] **Step 5: ACCEPTANCE (manual, requires VPN + a real red build):** start the console, confirm the board shows live `web-test-s4-flaky` builds with failed counts; click Triage on a red build; complete one real session end-to-end (clusters appear → pick one easy cluster → fixes verified green or flagged) with the diff visible in the web-test repo working tree and nothing committed. Only after this passes is v1 done.

- [ ] **Step 6: Commit** — `console: e2e smoke + README`

---

## Self-review notes (applied)

- Spec coverage: builds board (T4–7), one-click/paste/deep-link (T7), driver + SKILL loop (T9), question bridge + policy (T10, policy via prompt in T9's `buildPrompt` — enforcement stays with the kit's rails per spec), convergence board (T8/T10/T12), notifications (T11), resume (T9 pause/resume via sessionId + existing routes), one-run-at-a-time: **add to T9 Step 5** — in `index.ts` `POST /api/runs`, reject with `409 { error: 'a triage run is already active' }` when `runStore.listActive().length > 0` (the visible-queue refinement is deferred; spec's "queue with position" downgraded to reject-with-message for v1 simplicity — revisit if it annoys).
- Caching per build: ES cache in T6; ingest/cluster artifact reuse across restarts is the kit's own ledger behavior (resume prompt says re-read ledger).
- Type consistency: `Cluster`/`PhaseId`/`RunConfig` defined once (T2) and imported everywhere; `QueryFn`/`DriverHandle` defined in T9 and consumed by T13's demo path; `makeCanUseTool`/`hektorMcpServer` stubs in T9 replaced in T10 with identical signatures.
- **Deliberate deviation from the spec:** the first-run "auto-detect + one confirmation screen" wizard is downgraded to a documented config file + a quickly-import one-liner (T3 `importDefaults` + T13 README). Rationale: v1 has exactly one user who already knows every value; the wizard is UI surface with no unknowns behind it. Revisit at team-packaging time.
