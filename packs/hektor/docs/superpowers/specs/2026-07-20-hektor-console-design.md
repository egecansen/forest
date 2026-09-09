# Hektor Console — Design

**Date:** 2026-07-20 · **Status:** approved for planning · **Owner:** Egecan Sen

A local GUI ("Hektor Console") for the flaky-triage-kit: one place to see the latest red
`web-test-s4-flaky` / `web-test-s4-tag` builds, start a full interactive triage session on one of
them, and track the session live — replacing the terminal loop entirely for day-to-day use, while
the kit itself stays byte-identical and terminal-driven workflows keep working.

## Decisions taken (with the user)

| Decision | Choice |
|---|---|
| Primary job | Full interactive triage UI — clusters table, picks, apply approvals, verdicts all in the GUI |
| Audience v1 | Egecan's machine only; team packaging later |
| Trigger scope | Triage only — no Jenkins job triggering/stopping in v1 |
| Approach | Local web app + embedded Claude agent (kit unmodified, GUI = one more harness) |
| Codebase | **Fork of sahika** (`client/` + `server/`) into `hektor/apps/console`, rebranded `hektor`; possibly re-combined with sahika later |
| Ease-of-use extras | All five: zero-config import from quickly, one-click/deep-link entry, notifications + resume, decision policy, convergence board |

## Architecture

```
┌──────────────────── Browser (localhost) ─────────────────────┐
│  React UI (sahika shell): Builds board · Run view · History  │
└──────────────△───────────────────────────────────────────────┘
               │ HTTP + ws (sahika's existing transport)
┌──────────────┴───────────────────────────────────────────────┐
│  Node/TS server (Express, forked from sahika)                │
│  • Trackers: Jenkins + ES polling (ported from quickly)      │
│  • Run store / persistence / pending-answers (inherited)     │
│  • Driver: Claude Agent SDK session driving the kit          │
└─────△──────────────────────△──────────────────────△──────────┘
   Jenkins API / ES       kit core/*.sh + gradle   Agent SDK
   (track half)           (triage half)            (Claude auth on machine)
```

- **Location:** `hektor/apps/console/` (this repo). Starts as a copy of
  `~/sahibinden/repo/sahika`'s `client/` and `server/`; branding switched to `hektor` (the user's
  mockups already show this). sahika itself is not modified.
- **Stack (inherited):** Express + ws server (`:8765`, Vite dev server `:5173` — sahika's
  defaults), React + Vite + TypeScript client, vitest on both sides, the sahika `global.css`
  design system (mono type, yellow accents, light/dark themes).
- **State:** run history + artifacts in `~/.hektor-console/runs/<id>/`; app config in
  `~/.hektor-console/config.json`. The kit's `core/config.json` stays the single source of truth
  for everything the engine itself uses (ES host/allowlist, source_roots, bounds, recipes).

## Components

### 1. Driver (replaces `simulator.ts`)

`startDriver(run, queryFn, {resume})` — the seam already present in the fork — is implemented with
a headless **Claude Agent SDK** session:

- `cwd` = the web-test repo, where the kit is installed at `.claude/skills/hektor-flaky-triage/`;
  the agent loads the same SKILL.md and self-protection hooks as a terminal session. Kit unchanged.
- A short system-prompt append: the agent runs under Hektor Console and must route all user
  interaction through question tools, never assume a terminal.
- **Question bridge:** the SDK `canUseTool` callback intercepts the agent's `AskUserQuestion`
  calls (its user-interaction points) and registers them with the inherited `pending-answers`
  module; the browser renders them via
  `QuestionModal` (cluster pick) or an approval dialog (apply diffs); `POST
  /api/runs/:runId/answer` resolves the blocked callback. One pending question per run.
- **Decision policy:** a per-run toggle "auto-approve applies matching known recipes". Enforced
  server-side in the same callback: recipe-matched applies resolve immediately; everything else
  blocks + notifies. The cluster pick is never automated. Safety relies on the kit's own rails
  (`apply.sh` confined to `source_roots`, testbox-only, never commits) — the policy only skips a
  click, it grants no new capability.
- **Resume:** SDK session ID persisted per run; interrupted runs (crash/sleep/restart) show a
  Resume action that re-attaches via the existing `{resume}` option. Ingest/cluster artifacts are
  cached per build ID so restarts never re-ingest needlessly.
- **Concurrency:** one running session at a time (reruns monopolize the testbox and Gradle); other
  requested sessions queue with a visible position.

### 2. Builds board (new screen — the triage entry point)

- Polls Jenkins (job list imported from quickly's `config.json`) and the ES report host for
  failed-test counts. Fetch/retry/backoff logic ported from quickly's `jenkins.js`, including
  s-report URL construction (`…/web-test-s4-flaky/<n>?buildStartTime=…&fullTestBuildName=…`).
- Per build: status + pipeline stage, TAG, Jira ticket, starter, failed count, links (Jenkins +
  report). Filters: TAG / Jira ticket / only-mine, persisted locally. Builds already triaged show
  their session result chip inline.
- Actions: **Triage** per red build · **Triage latest** · paste-an-s-report-URL · deep-link route
  (`/triage?url=…`) for a later quickly button. All validate the URL against the kit's
  `es.host_allowlist` before a run starts.
- Efficiency: server polls only while ≥1 client is connected; finished builds' ES counts cached
  permanently.

### 3. Run view (adapted from sahika)

- **Phases** (`phases.ts`): `01 Ingest → 02 Cluster → 03 Pick → 04 Fix → 05 Verify → 06 Report`
  drive the PIPELINE rail. Fix/Verify render per-cluster convergence chips:
  `queued → fixing → verifying (pass n/N) → ✅ green / 🐞 app-bug / ⚠ error`.
- **Tabs:** Log (agent transcript, collapsed by default) · Timeline · **Clusters** (replaces
  Findings: the easy-fix→likely-bug table, the pick UI, live per-cluster state) · Files (applied
  diffs) · Report (`summary.sh` output as the final report card). Journeys/Recording dropped in v1.
- Decision points park indefinitely ("⏸ waiting for you"); no auto-decisions beyond the explicit
  recipe policy.

### 4. Config & notifications

- First run: auto-detect the kit + repo (reusing `install.sh` detection logic) and import
  Jenkins/ES/Jira settings from quickly's `config.json`; one confirmation screen. Secrets live only
  in `~/.hektor-console/config.json` (never in git).
- Desktop notifications (macOS) fire only at: clusters-ready-to-pick, apply-approval-needed,
  session finished/interrupted.

## Error handling

- **Trackers degrade, never block:** on Jenkins/ES failure the board keeps last data with a
  "stale since HH:MM" badge and retries with backoff. Paste-URL triage works with trackers down.
- **Sessions are interruptible:** artifacts persist as they're produced; interrupted runs resume,
  or "restart from last artifact" reuses cached `fails.json`/`clusters.json`.
- **Engine errors surface:** failed `rerun.sh`/Gradle marks the cluster chip `error` with the
  output tail expandable; the kit's semantics decide the agent's next step.
- **Safety edges:** server binds `127.0.0.1` only (sahika's `host-guard` retained); deep-link and
  pasted URLs validated against `es.host_allowlist` (the kit's SSRF seam); no secrets in the repo.

## Testing

- **Unit:** trackers vs recorded Jenkins/ES fixtures; session state machine
  (queue → running → waiting → done/interrupted); policy gate (recipe ⇒ auto, else block).
- **Contract:** question bridge round-trip — fake agent blocks on `canUseTool`, UI event fires,
  posted answer resolves it.
- **Integration:** scripted end-to-end run with a mocked SDK (ingest→cluster→pick→apply→summary)
  against fixtures; the retired simulator's fixtures seed these.
- **UI smoke:** Playwright happy path against the mock driver.
- **Acceptance:** one real triage session on a real red build before v1 is done.

## Out of scope for v1 (explicitly later)

Jenkins job triggering/stopping · quickly "Triage →" button (deep-link exists, button comes later) ·
multi-testbox parallel sessions · team packaging/distribution · re-combining console + sahika into
a shared shell · Jira/Bitbucket panels beyond what the board shows.
