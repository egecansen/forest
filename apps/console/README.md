# hektor console

GUI console for the Hektor flaky-triage kit (forked from the şahika shell). Point it
at a red `web-test-s4-flaky` build, it starts a triage session against the kit's
`.claude/skills/hektor-flaky-triage` skill, and streams progress — clusters,
decisions it needs from you, files touched, a green-proof scoreboard — live in the
browser.

## Running it

```sh
npm run install:all   # installs the root, client, and server workspaces
npm run dev           # server on :8765, Vite dev client on :5173 (proxies to :8765)
```

Production (single process, server serves the built client):

```sh
npm run build          # builds BOTH the client (Vite) and the server (tsc)
npm start              # node server/dist/index.js, listening on :8765
```

Tests:

```sh
npm --prefix client test   # vitest — client
npm --prefix server test   # vitest — server
npm run test:e2e           # playwright — end-to-end smoke (see below)
```

Run history and config live under `~/.hektor-console/` — override the location with
`HEKTOR_CONSOLE_HOME` (the e2e suite uses this to point at an isolated fixture
directory instead of your real config; see `playwright.config.ts`).

## Config: `~/.hektor-console/config.json`

The console won't show live builds or accept a triage run until this file exists.
Copy-paste and fill in:

```json
{
  "repoPath": "/absolute/path/to/web-test",
  "testbox": "tb161",
  "jenkins": {
    "baseUrl": "https://jenkins.example.net",
    "jobUrls": ["https://jenkins.example.net/job/web-test-s4-flaky"],
    "username": "you",
    "apiToken": "…"
  },
  "es": {
    "url": "https://elastic.example.net",
    "index": "web-test-report",
    "username": "you",
    "password": "…"
  },
  "reportBase": "https://report-with-elastic-data.example.net",
  "pollMs": 15000
}
```

- `repoPath`, `testbox`, `reportBase`, `jenkins.{baseUrl,jobUrls}`, `es.{url,index}`
  are required; `jenkins.{username,apiToken}` and `es.{username,password}` are
  optional (omit for anonymous access). `pollMs` defaults to `15000` (floor `5000`).
- The report-URL **host allowlist** used by `POST /api/runs` is read separately,
  from the kit already installed at `repoPath`: `<repoPath>/.claude/skills/hektor-flaky-triage/core/config.json`'s
  `es.host_allowlist`. A triage run against a report URL whose origin isn't in that
  list is rejected — the kit stays the authority on what hosts are safe to query.

### First-run import from `quickly`

If you already have `quickly`'s config with Jenkins/Elasticsearch settings, seed
`jenkins`/`es` from it instead of retyping them (still fill in `repoPath`/`testbox`/
`reportBase` yourself — `importDefaults` only knows about Jenkins/ES):

```sh
cd apps/console/server && npm run build   # ensure dist/console-config.js exists
node --input-type=module -e '
import { importDefaults } from "./dist/console-config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const quicklyConfig = path.join(os.homedir(), "sahibinden/repo/quickly/config.json");
const defaults = await importDefaults(quicklyConfig);
const home = process.env.HEKTOR_CONSOLE_HOME ?? path.join(os.homedir(), ".hektor-console");
fs.mkdirSync(home, { recursive: true });
const configFile = path.join(home, "config.json");
const existing = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
fs.writeFileSync(configFile, JSON.stringify({ ...existing, ...defaults }, null, 2));
console.log("wrote", configFile);
'
```

Then open `~/.hektor-console/config.json` and fill in whatever the import left blank.

## Deep-link format

`/?triage=<url-encoded report URL>` opens the console straight to the triage start
form with the report URL pre-filled — e.g. from a Slack link, a Jenkins console-log
paste, or the "triage" button on a builds-board row (which constructs this same
link). Example:

```
http://localhost:8765/?triage=https%3A%2F%2Freport-with-elastic-data.example.net%2Fweb-test-s4-flaky%2F2127%3FbuildStartTime%3D1%26fullTestBuildName%3Dsome-build
```

A report URL whose `fullTestBuildName` is `demo` (or a page URL carrying `?demo`)
additionally reveals a **demo mode** checkbox on the start form: checking it runs a
fully scripted triage session (`server/src/driver.ts`'s `makeDemoQueryFn`) — no
SDK/Jenkins/Elasticsearch access, no filesystem writes — that walks a cluster
through pick → fix → verify → green. It's what `e2e/smoke.spec.ts` exercises, and a
handy way to poke at the UI without a live build.

## End-to-end smoke test

```sh
npm run test:e2e   # = npx playwright test
```

`playwright.config.ts` builds and starts the console against an isolated fixture
`HEKTOR_CONSOLE_HOME` (materialized fresh under `e2e/fixtures/console-home/` on
every run — not checked into git, since it bakes in this checkout's absolute path)
so it never touches your real `~/.hektor-console/config.json`, and listens on
**:8799** (not the normal :8765) so it doesn't fight a dev server you may already
have running. `e2e/smoke.spec.ts` drives the whole demo path end to end: deep link →
prefilled form → demo run → clusters appear → answer the AskUserQuestion pick
through the real operator bridge → the picked cluster verifies green → the run
completes.

Requires a locally installed **Google Chrome** (the config uses
`channel: 'chrome'` rather than downloading Playwright's bundled Chromium — no
`playwright install` needed).

## Acceptance (manual — requires VPN + a real red build)

This is the actual go/no-go gate for v1; nothing above substitutes for it. Run it
yourself once the console is configured and built:

1. Start the console, confirm the board shows live `web-test-s4-flaky` builds with
   failed counts.
2. Click **Triage** on a red build.
3. Complete one real session end-to-end: clusters appear → pick one easy cluster →
   fixes verified green or flagged, with the diff visible in the web-test repo's
   working tree and **nothing committed**.

Only after this passes is v1 done.

### Acceptance run with MCP disabled

This proves the ledger alone carries the contract without MCP server tool calls:

```sh
HEKTOR_DISABLE_MCP=1 PORT=8790 npm start
```

Then run one real triage end-to-end. Pass criteria:
- Clusters appear from the ledger within ~2 seconds of the agent's upserts
- Pick works (AskUserQuestion still active)
- Chips progress to verdicts
- `ledger.sh validate --final` passes before the summary
- Report tab shows complete scoreboard

This exercises the entire pipeline via ledger-only state, proving the console is not dependent on MCP tool calls for core functionality.
