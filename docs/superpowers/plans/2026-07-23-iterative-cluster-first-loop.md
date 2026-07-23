# Iterative Cluster-First Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` tracking. Kit tasks run SEQUENTIALLY under the unlock cycle; the console task is scoped around the user's parallel console work.

**Goal:** Reorder the triage loop so the cluster table appears *from the report* before any full rerun, the user picks (multi-pick), only the picked cluster is re-run to confirm before fixing, then it re-clusters and continues — with a cheap up-front broken-box health-check kept for safety.

**Architecture:** Almost entirely a kernel §4 operating-contract rewrite + SKILL/adapter discipline (no `core/*.sh` signature changes — `rerun.sh` already takes an FQCN csv, `cluster.sh` already clusters FAILED docs). Plus a minor console legibility layer (round counter + new-cluster marker); the board is already ledger-driven and the pick already recurs, so the loop functions without console changes — Task 2 makes multi-round runs legible.

**Tech Stack:** Markdown (kernel/SKILL/.mdc), TypeScript/React/vitest (console). No new deps.

**Spec:** `docs/superpowers/specs/2026-07-23-iterative-cluster-first-loop-design.md`

## Global Constraints
- Kit is self-protected + currently LOCKED. Task 1 brackets: `HEKTOR_FLAKYKIT_UNLOCK=1 kits/flaky-triage-kit/core/lock-kit.sh unlock` … edits (every write prefixed `HEKTOR_FLAKYKIT_UNLOCK=1`) … `lock` at task end. No `core/*.sh` behavior changes in this plan.
- Invariants preserved, reordered only: **I9** broken-box → the cheap up-front health-check; **I4** mask-a-regression → the confirm-on-box now happens per picked cluster *before* applying. I1/I2/I3/I5/I7/I10/I11 unchanged. Two human gates only (cluster-selection, review-commit).
- Multi-pick allowed per round; re-cluster after each round (remaining + newly-surfaced).
- Console: **do NOT touch** files in the user's parallel stream — `StartScreen.tsx`, `server/src/index.ts`, `console-config.ts`, `resolve-*.ts`, `testbox-routing.ts`, `srp*.ts`, `trackers/es.ts`, `trackers/srp.ts`. Task 2 is confined to `RunConsole.tsx`, `ClustersTab.tsx`, `client/src/types.ts` (additive), `ledger-watcher.ts` test only. Commit promptly to avoid being swept into a user commit.
- No AI-attribution commit trailers. Console suites green (`npm --prefix server test`, `npm --prefix client test`, `npm run build`, `npx playwright test`); live :8790 untouched.

---

### Task 1: Kernel §4 loop rewrite + adapter discipline (the reorder)

**Files:** `kits/flaky-triage-kit/kernel.md` (§4), `kits/flaky-triage-kit/adapters/claude/SKILL.md`, `kits/flaky-triage-kit/adapters/cursor/hektor-flaky-triage.mdc`.

**Interfaces:** Produces the normative loop every harness follows. No code interfaces.

- [ ] **Step 1: Unlock the kit.** `HEKTOR_FLAKYKIT_UNLOCK=1 kits/flaky-triage-kit/core/lock-kit.sh unlock`

- [ ] **Step 2: Rewrite kernel.md §4's loop block** to (replace the fenced `0.–6.` block; keep the "Two human gates" + "Keep it simple" paragraphs verbatim below it):

```
0. INPUT        s-report + tb                                    [validated §3]
1. INGEST&PIN   pull FAILED docs for the pinned build from ES
2. HEALTH-CHECK cheap tb probe (I9) — a known-good check / per-test ES history, NOT a full
   /tb          rerun. Near-all-fail or unreachable box ⇒ broken box: stop, say so, present NO
                table (a broken box makes every failure look real). Seconds, not minutes.
3. CLUSTER      group the report's FAILED docs by MEANING a human recognizes (selector moved ·
   (from report) VRT baseline drift · app behavior change · redesign migration · flaky-infra ·
                likely-bug) — re-group the mechanical signature; NEVER raw-exception buckets.
                per cluster: bucket · fix-vs-🐛 (evidence-gated) · action · its tests.
                skip clusters already green in current code.
                ONE table, easy-fix → likely-bug, one line each  ── STOP: which cluster(s)? ──
                (multi-pick allowed; NO confirmation rerun has run yet — cluster from the report)
4. CONFIRM&APPLY for each picked cluster: RE-RUN ONLY ITS TESTS on tb (clean) — confirm real vs
   (per cluster) flaky/already-green (I4/I9 evidence: golden BEFORE vs tb NOW; dismiss any that
                pass). Then take the confirmed-real ones END-TO-END: apply to the WORKING TREE
                (clean-tree check, diff, never commit) → GREEN-PROOF (widen to the shared-layout
                blast radius when the edit hits a shared Page/Layout). Report the batch ONCE.
5. RE-CLUSTER   re-cluster the REMAINING + any newly-surfaced failures; present the UPDATED table.
   &RE-ENGAGE   steering may split/redefine. loop to 3's decision (pick the next). one prompt,
                not per-item.
6. CONVERGE     emit the convergence summary. user reviews the diff and commits.  ── kit NEVER commits ──
```

- [ ] **Step 3: Update the §4 note.** After the block, keep "Two human gates only (cluster-selection §3-step-3, review-commit §6)…" — adjust the step numbers to the new block (selection is now step 3, converge step 6). Keep the "Keep it simple" paragraph unchanged.

- [ ] **Step 4: Update SKILL.md's "The loop" section** to match: cluster-from-the-report is the FIRST table (no up-front confirmation rerun); the confirmation rerun is per picked cluster at step 4 (`rerun only the picked cluster's FQCNs`); step 5 re-clusters and re-presents each round. Preserve the Stage-2 ledger discipline already there (provisional upsert at the mechanical cut → refine before presenting; record cluster-state/`event phase-enter`; `validate --final` before the summary). Add one line: "Present the cluster table BEFORE any full rerun — only a cheap health-check precedes it; the per-cluster confirmation rerun happens after the pick, before applying that cluster."

- [ ] **Step 5: Mirror the same three edits into the cursor `.mdc`** loop section, identical wording.

- [ ] **Step 6: Verify** — `grep -q "HEALTH-CHECK" kits/flaky-triage-kit/kernel.md` and `grep -q "RE-RUN ONLY ITS TESTS" kits/flaky-triage-kit/kernel.md`; `grep -q "cheap health-check" kits/flaky-triage-kit/adapters/claude/SKILL.md` and the cursor `.mdc`; confirm `git diff --stat` shows only kernel.md + the two adapters. All kit test suites still green (prose-only change; run `bash core/tests/ledger-test.sh` etc. without the unlock env — no behavior changed).

- [ ] **Step 7: Reinstall + re-lock.** `kits/flaky-triage-kit/hektor-triage-kit install --project /Users/egecan.sen/sahibinden/repo/web-test` (verify installed SKILL.md carries "cheap health-check"); regenerate the zip via `kits/flaky-triage-kit/scripts/package-kit.sh`; `HEKTOR_FLAKYKIT_UNLOCK=1 kits/flaky-triage-kit/core/lock-kit.sh lock`.

- [ ] **Step 8: Commit** — `git add kits/flaky-triage-kit/kernel.md kits/flaky-triage-kit/adapters && git commit -m "kit: iterative cluster-first loop — cluster from report, rerun only the picked cluster, re-cluster each round"`

---

### Task 2: Console round legibility (round counter + new-cluster marker)

**Files:** `apps/console/client/src/components/RunConsole.tsx`, `apps/console/client/src/components/ClustersTab.tsx`, `apps/console/client/src/types.ts` (additive), `apps/console/server/src/__tests__/ledger-watcher-v2.test.ts` (multi-round regression), `apps/console/client/src/styles/global.css`. **Do NOT touch the user's parallel files (see Global Constraints).**

**Interfaces:**
- Consumes: existing `RunSnapshot.clusters` (`Cluster[]`), the phase model (`ingest→cluster→pick→fix→verify→report`, forward-only high-water), the Stage-2 watcher carry-forward.
- Produces: a derived `round` count shown in the run header + a per-cluster "new this round" visual marker; no server/schema change.

- [ ] **Step 1: Failing test — round count derivation (pure).** Add `client/src/run-round-logic.ts` with `deriveRound(clusters: {state: string}[]): number` — the round is `1 + (number of clusters that have reached a terminal state green|app-bug|skipped|error)` capped sensibly, representing "how many rounds of verdicts have landed." Test in `client/src/__tests__/run-round-logic.test.ts`:

```ts
import { deriveRound } from '../run-round-logic';
test('round 1 when nothing terminal yet', () => {
  expect(deriveRound([{ state: 'proposed' }, { state: 'picked' }])).toBe(1);
});
test('advances a round after a terminal verdict lands', () => {
  expect(deriveRound([{ state: 'green' }, { state: 'proposed' }])).toBe(2);
});
test('empty clusters → round 1', () => {
  expect(deriveRound([])).toBe(1);
});
```

- [ ] **Step 2: Run — FAIL** (`npm --prefix client test -- run-round-logic`). **Step 3: Implement** `deriveRound`:

```ts
const TERMINAL = new Set(['green', 'app-bug', 'skipped', 'error']);
export function deriveRound(clusters: { state: string }[]): number {
  return 1 + (clusters.some((c) => TERMINAL.has(c.state)) ? 1 : 0);
}
```

(Round is "1" until the first verdict lands, then "2+"; keep it minimal — a coarse "which pass are we on" hint, not a precise counter. If a richer count is wanted later, it can grow.)

- [ ] **Step 4: Run — PASS.** **Step 5:** In `RunConsole.tsx`, show `round <n>` in the run header's status area (only when the run is a triage run and `clusters.length > 0`), using `deriveRound(snapshot.clusters)`. Reuse existing header chip styling. Add an RTL assertion in `run-console.test.tsx` that a snapshot with a green + a proposed cluster renders `round 2`.

- [ ] **Step 6: New-cluster marker.** `Cluster` gains optional `firstSeenRound?: number` is NOT persisted server-side (avoid schema churn + user-file collision) — instead derive "new" purely client-side: in `ClustersTab.tsx`, a cluster in `proposed` state while the run already has ≥1 terminal cluster (i.e. `deriveRound > 1`) renders a subtle `new` tag (reuse an existing muted chip class). RTL: with one green + one proposed cluster, the proposed row shows `new`; in round 1 (no terminals) no row shows `new`.

- [ ] **Step 7: Watcher multi-round carry-forward regression.** In `ledger-watcher-v2.test.ts`, add a test: round-1 ledger has clusters A(green), B(proposed); a round-2 ledger read adds C(proposed) while A stays green and B unchanged → the watcher's desired set contains A, B, AND C (carry-forward holds across rounds; A the terminal is not dropped when C appears). This locks the Stage-2 carry-forward for the iterative loop. (Server-only test; no watcher code change expected — if it fails, the carry-forward has a multi-round gap to fix.)

- [ ] **Step 8:** Full client + server suites + build + `npx playwright test` green.

- [ ] **Step 9: Commit** — `git add apps/console/client/src apps/console/server/src/__tests__/ledger-watcher-v2.test.ts && git commit -m "console: round counter + new-cluster marker for the iterative loop"`

---

## Self-review notes
- Spec coverage: §"The loop after" → Task 1 kernel block; §"Changes/Kit" → Task 1 SKILL+mdc; §"Changes/Console" (round counter, new-cluster marker, carry-forward across rounds) → Task 2. §"What's preserved" (I9 health-check, I4 confirm-before-apply) → Task 1 steps 2/4 wording. No gaps.
- No `core/*.sh` change is intentional (spec §Changes/Kit: "discipline/ordering change, not an engine rewrite") — `rerun.sh`/`cluster.sh` already support the new sequencing.
- Type consistency: `deriveRound(clusters)` signature identical across Task 2 steps; terminal set matches the premature-end guard's (`green|app-bug|skipped|error`).
- Deliberate scoping: `firstSeenRound` deliberately NOT added to the schema (avoids user-file collision + churn) — "new" is derived client-side.
