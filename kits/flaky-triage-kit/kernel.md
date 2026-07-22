# Hektor Flaky-Triage Kit — Kernel Spec

**Status:** DRAFT — refine + vuln-hunt against this doc.
**Scope (this phase):** flaky **testbox** runs only.
**Out of scope (this phase):** prod/preprod runs · Jenkins/unattended automation · ticket filing · committing.

The kernel is **form-agnostic** — it's the brain the eventual Hektor skill *and* the Jenkins
stage will both implement. Everything is generic except §10 (the sahibinden config seam).

---

## 1. Purpose

Given a flaky-run **s-report + a testbox**, separate real failures from flaky / per-box /
report noise, cluster by root cause, propose and (on the user's selection) apply test/selector
fixes **verified green on that tb**, and flag suspected app-bugs for the user's investigation —
**without ever filing tickets, disabling tests, or committing**.

## 2. Trust model (read first)


| Entity                                               | Trust                                       | Consequence                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Report data** (testName, stackTrace, tags…)        | **UNTRUSTED**                               | validate before any shell/query/path use; may be stale/poisoned/malformed                                                                                                                                 |
| **Current codebase**                                 | **source of truth**                         | what exists / is already fixed; cross-check every `testPath`                                                                                                                                              |
| **The testbox**                                      | **verification oracle**                     | health-check first; a broken box invalidates every verdict                                                                                                                                                |
| **The user**                                         | **sole authority**                          | for fixes applied, bugs confirmed, tickets, disables, commits                                                                                                                                             |
| **ES s-report**                                      | **untrusted-current**                       | pass/fail history (the failure list) + flaky-history pivot; verify vs live                                                                                                                                |
| **qagent** (golden steps/selectors + business rules) | **untrusted-advisory** (snapshot, semantic) | enriches evidence; verify vs code/tb; its golden selector may itself be brittle                                                                                                                           |
| **jira ticket** (the build's `jiraTicket`)           | **untrusted-advisory, read-only**           | scope = description + **ALL linked tickets (one hop)**; **the bare tag is build-level (tags every failing test) ⇒ a FALSE per-cluster signal** — overlap the *scope*, not the tag; **never written** (I8) |


**Evidence combines as a diff:** qagent gives the golden *before* (selectors, steps, expected rules), the tb re-run gives *now*, current code is *truth* — classify from the **delta**, never one source alone.

**Determinism (of the logic, not the verdicts):** the classification *logic* is deterministic — same `(report, code)` → same clusters — but the **re-run verdicts are NOT** (Selenium / timing / live data / ads), which is exactly why flaky = a *confidence* over N runs, not one pass. The report and the re-run are also **time-shifted**: a pass can mean flaky / resolved-upstream / data-drift / per-box — four verdicts with four actions. **Disambiguate; never collapse all four to "flaky."**

## 3. Inputs & validation

- `sReportUrl` — host **allowlisted**; extract `fullTestBuildName` + `buildStartTime`.
- `tb` — target testbox id, must be **numeric** (`^[0-9]+$`).
- `testBuildName` — must match the known job pattern.
- **Build disambiguation:** resolve by exact `testBuildName.keyword` **AND** `@timestamp ≈ buildStartTime`. Never by build number alone — they're reused (stale-build trap).

## 4. The loop (operating contract)

```
0. INPUT        s-report + tb                                    [validated §3]
1. INGEST&PIN   pull FAILED docs for the pinned build from ES
2. RE-RUN/tb    run exactly those failing tests on tb, clean.
                flaky = a CONFIDENCE (N re-runs / retry+fail counters), not one pass
                → splits  real | flaky | per-box | noise
3. CLUSTER      group by MEANING a human recognizes (selector moved · VRT baseline drift ·
                app behavior change · redesign migration · flaky-infra · likely-bug) —
                re-group the mechanical signature; NEVER present raw-exception buckets.
                per cluster: bucket · fix-vs-🐛 (evidence-gated) · action.
                skip clusters already green in current code.
                ONE table, easy-fix → likely-bug, one line each  ── STOP: one decision ──
4. SELECT&APPLY user picks cluster(s) and/or steers; take them END-TO-END:
                apply to the WORKING TREE (clean-tree check, diff, never commit) →
                GREEN-PROOF (widened to the shared-layout blast radius when the edit hits
                a shared Page/Layout). Make obvious fix calls yourself; report the batch ONCE.
5. RE-ENGAGE    one short prompt for the REMAINING clusters (not per-item);
                steering may split/redefine → new clusters → loop to 4
6. CONVERGE     emit the convergence summary.
                user reviews the diff and commits.   ── the kit NEVER commits ──
```

Two human gates only: **cluster-selection** (step 4) and **review-commit** (step 6) — do not
add a third by stopping for mechanics or per-item micro-approvals.

**Keep it simple (the operating style).** The user drives this and reads every turn; give the
map and the decision, not the engine. ONE easy→bug table, minimal per-row detail, clusters by
meaning. Keep build ids / run anomalies / rerun+dom mechanics / task ids OUT of the reply — use
the tools silently and surface conclusions. Between the two gates, execute end-to-end and report
once. This style is the kit's contract, not a preference; a long, stop-heavy turn means you've
drifted. (Regressions still get flagged, never masked — I4.)

## 5. Classification

### 5.0 Evidence sources (all advisory except code + tb)


| Source                                           | Gives                                                                                                                                                                                          | Trust                             | Used for                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ES s-report                                      | build-over-build pass/fail                                                                                                                                                                     | untrusted-current                 | the failure list; flaky-history pivot                                                                                                                    |
| qagent `*_teststeps`                             | golden selector + step sequence + navigate URL **+ client/API calls (FeatureGateway/user clients) + the golden testbox**                                                                       | untrusted-snapshot                | moved-vs-vanished *before*; repro; recipe siblings; **flag/user-dependency detection; control-box candidate**                                            |
| qagent `*_business_rules`                        | documented expected behavior (Confluence)                                                                                                                                                      | untrusted-snapshot                | the fix-vs-🐛 evidence (does the app violate a *documented* rule?)                                                                                       |
| current code                                     | what exists / already fixed                                                                                                                                                                    | **truth**                         | existence (I2); shared-layout blast radius                                                                                                               |
| tb re-run                                        | live *now* behavior                                                                                                                                                                            | **oracle**                        | green-proof; the "now" half of the diff                                                                                                                  |
| jira ticket (`build.jiraTicket` → Atlassian MCP) | the ticket's **description** + **EVERY linked ticket, one hop** (DEP Issue Distribution / Story cloners + parent epic + siblings, each read for its description/dev-PR) = the change **scope** | untrusted-advisory, **read-only** | reweight flaky→real only when a cluster overlaps the ticket's **scope** — the bare tag is **build-level (tags every test) = a FALSE per-cluster signal** |


**Core move — diff golden *before* vs *now*:**

- gone now **but a same-semantic element exists under another locator** → *moved* → 🔧 (re-locate by the **robust sibling**, never the golden brittle id).
- gone now, **no robust locator finds it**, business rule says it should exist → *vanished* → 🐛.
- test self-consistent but app contradicts a **documented business rule** → 🐛 (cite the rule id).

Use `where:{testName}` for an exact flow; semantic query only for sibling/recipe discovery. Never adopt a qagent hit without verifying against current code + the tb.

### 5.1 Buckets (flaky-testbox signatures)


| Signature                                                                     | Meaning                                                                    | Default action                                   | Bucket     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ | ---------- |
| passes on re-run                                                              | flaky / race                                                               | dismiss (record flaky-confidence)                | infra      |
| whole-class Timeout / NotInteractable / NoSuchElement                         | **broken box**                                                             | invalidate verdict, re-run elsewhere (I9)        | infra      |
| `ElementClickIntercepted` (`ot-sdk-row`)                                      | OneTrust cookie overlay                                                    | 🔧 recipe: dismiss-in-setup                      | easy-fix   |
| `VisualRegressionTrackerException`                                            | baseline drift                                                             | advisory (baseline review)                       | vrt        |
| `NoSuchElement` on a generated/hard-coded id                                  | brittle selector                                                           | 🔧 re-locate by name (T1/T3)                     | selector   |
| `NoSuchElement` on a filter-value-by-text (`//label[text()='Sıfır']`, `'5G'`) | **data/flag-dependent** (option renders only with matching inventory/flag) | re-run on a control box — **not** a selector fix | infra      |
| `IndexOutOfBounds` (empty list)                                               | data-dependent                                                             | 🔧 empty-guard (T2)                              | easy-fix   |
| `AssertionFailedError`, self-consistent test                                  | **app contract violation**                                                 | 🐛 suspected bug (T4)                            | likely-bug |
| `AssertionFailedError`, testbox-data assumption                               | brittle assertion                                                          | 🔧 make data-aware (T2)                          | app-change |

**Canonical presentation buckets (closed enum):** easy-fix · selector · vrt · app-change · infra · likely-bug — every cluster carries exactly one (§8).

**Signature extraction:** cluster on the **root cause**, not the first stack line — wrapped / `MultipleFailures` (e.g. `AssertionFailedError: Multiple Failure : [VRT…]`) misbucket otherwise; split `MultipleFailures` into sub-failures (V6).
**Cluster homogeneity:** before applying one fix to a cluster, verify its tests truly share that one fix — else re-cluster (V10).

### 5.2 Tiers (present easy → hard)

- **T1 clean fix** — test-local, single file, high-confidence selector fix, re-runs green.
- **T2 moderate** — data / assertion-resilience, still test-local.
- **T3 risky** — shared-layout fix → needs blast-radius green-proof.
- **T4 investigate** — 🐛 suspected app-bug, or low-confidence / ambiguous.

### 5.3 Fix vs 🐛 bug — evidence-gated

- 🔧 **FIX** only if the test's own logic is brittle/stale (selector moved/renamed but the element **still exists in changed form**; data assumption; flaky timing).
- 🐛 **SUSPECTED BUG** if the test is **self-consistent** and the *app* broke its contract, **or the target element vanished** (feature break).
- **Mask-regression invariant (I4):** never propose a selector fix for a *vanished* element — that's a 🐛, not a 🔧. Otherwise we silently paper over a real break.
- **Confirm at pass^N, not pass^1:** a fix counts as "fixed" only when green on *all* N re-runs (`rerun` `confidence==1.0` over `runs≥N`). A single green run is the most likely **false** "fixed" — a flaky test passes ~half the time. Classify fix-vs-🐛 skeptically: require evidence, default to 🐛 when unsure (a separate hard look beats optimistic self-grading).

### 5.4 Signature → fix-recipe catalog (grows over time)


| Signature                                            | Recipe                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| OneTrust `ot-sdk-row` intercept                      | dismiss/accept OneTrust in setup (no-op on boxes that auto-dismiss) |
| generated `_cllpsID_aNN` facet id                    | re-locate by attribute **name** (`clickAttributeName`), not the id  |
| empty-list `IndexOutOfBounds`                        | guard empty results / pick an in-inventory param                    |
| testbox-inventory assertion (e.g. toplist on page 2) | make inventory-aware / relax the env-specific assert                |


## 6. Actions

- **🔧 Fix** — recipe-driven edit, in the **working tree** (clean-tree check), **path-confined** to the source
roots (§10), shown as a **diff for approval**, **green-proofed** before it's offered. Idempotent.
- **🐛 Suspected bug — ADVISORY ONLY** — show the evidence; the **only** code action is a
`// TODO: possible bug — investigate (<cluster>)` comment on top of the test.
**NEVER** create/comment a Jira ticket; **NEVER** apply `@ScheduledDisable`.
The user investigates and owns whether it's a bug, whether a ticket is needed, and whether to disable.
- **Skip already-handled** — if current code shows the test already fixed/disabled/de-tagged,
mark *resolved-upstream*; don't re-litigate.

## 7. Safety invariants (hard gates)


| #       | Invariant                                                                                                                                                                                                                                                                                | Closes                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **I1**  | Validate user inputs + every report-derived `testName/testPath` (FQCN regex) before any shell/query/path use; parameterize ES queries. **I2's existence-intersection is the *primary* defense for the run path — the regex is belt-and-suspenders**                                      | injection from untrusted report/inputs  |
| **I2**  | Act only on tests that **exist in current code** — prefer gradle's own discovery (`isFailOnNoMatchingTests=false`) over a hand-rolled check; **flag semantic drift** (same FQCN, changed test)                                                                                           | stale / renamed / poisoned entries      |
| **I3**  | Edits to the **working tree** (git-tracked → `git restore`-reversible), **confined to `source_roots`**, on a **clean tree** (refuse / branch if dirty); the kit **never commits** — you review the diff + commit. *(Worktree isolation deferred to the Jenkins/unattended phase — §11.)* | wrong-file / corrupt edit               |
| **I4**  | **Moved-vs-vanished is ambiguous → bias to 🐛.** A 🔧 selector fix is allowed ONLY if a *same-semantic* element is found by a robust locator — **qagent golden *before* vs tb *now* is the evidence**; absent by **any** locator → 🐛, never a fix                                       | **masking a real regression (V1)**      |
| **I5**  | **Re-derive "already applied" from the source**, not the (agent-authored) ledger — the ledger is an optimization, not the truth                                                                                                                                                          | non-idempotent re-runs (V4)             |
| **I6**  | Cap **per-cluster** (keep ≥1 representative of *every* signature) — never a global truncation that hides a whole cluster; confirm above threshold; log drops                                                                                                                             | runaway runs / silent truncation (V7)   |
| **I7**  | **Allowlist** the fields emitted into any artifact (testName, signature, status) — **never raw stackTrace / PII / tokens**; denylist-scrub is insufficient (you triage the *sensitive-data* suite)                                                                                       | data leakage (V3)                       |
| **I8**  | Never commit · file/comment a ticket · disable a test · act only on **selected** clusters. **Honesty: re-running tests executes real testbox side-effecting flows (not fully "reversible") — flag tests with irreversible external actions (payment/email)**                             | overreach / unflagged side effects (V5) |
| **I9**  | tb health-check is **necessary-not-sufficient** (misses *partial* degradation); cross-check suspicious whole-cluster flips vs a **control box / per-test ES history** — **qagent's golden testbox is a ready control-box candidate**                                                     | per-box confound (V9)                   |
| **I10** | **Pin one code revision** for classify + apply + green-proof (mismatched revs = inconsistent verdicts); **bound re-clustering** — every cluster must reach a terminal status; max iterations                                                                                             | rev-drift / non-convergence (V8, V10)   |
| **I11** | **A session may not end while any cluster is `selected`/`applied`** — run `core/ledger.sh validate --final <ledger>` before the convergence summary; non-zero exit means the run is NOT done (collect verdicts; never background the green-proof and quit)                                  | premature completion / unverified "fixed" claims |


## 8. State / ledger (resumable · idempotent · auditable)

```
run:     { id, sReportUrl, build{name,@timestamp}, tb, startedBy, version: 2 }
cluster: { id, title,                  # ≤80 chars, human phrasing — I7-governed: never raw stackTrace
           detail,                     # ≤600 chars evidence summary; may quote signatures, never full traces
           signature, tier, bucket,    # bucket ∈ the six (closed enum, kernel-canonical)
           fixVsBug, evidence,
           tests[ {fqcn, status?} ],   # status ∈ red|green|skipped, present only when diverging
           status: proposed|selected|applied|green|deferred|flagged|resolved-upstream,
           passes, runs,               # green-proof progress; integers; passes ≤ runs
           diffRef, lineage, greenProofScope }
event:   { who, what, when, phase? }   # what gains 'phase-enter'; phase ∈ ingest|confirm|cluster|pick|fix|verify|report
```

All writes go through ledger.sh subcommands (cluster-upsert / cluster-state / event) — hand-edited JSON violates P2. v1 files (no version) remain readable.

## 9. Output — convergence summary

Sections: **fixed (+green proof)** · **flagged-as-suspected-bug** (TODO + evidence, *not* filed)
· **deferred** · **still-flaky** · **resolved-upstream**. This is the artifact the user reviews
and commits against.

## 10. Config seam (sahibinden defaults — the portable part)

Everything above is generic; another team/app swaps **only** this section.

- **ES:** host `report-with-elastic-data.apps.ocptbox.tzla.sahibindenlocal.net`, index `web-report`, `POST /api/web-report/_search`, no auth.
- **Run:** from `web-ui-test/`; `JAVA_HOME=…/ms-17.0.16`; `-x :generate-method-plugin:instrumentCode`; Selenoid launchpad; select via `-Dtests=<csv-fqcns>` (preferred for a fix-list) or `-DincludeTags`; `-Dspring.profiles.active=testbox -Dui.testbox=<tb> -Denv.data.center=x -Dui.browser.type=chrome`.
- **Edit allowlist (source roots):** `web-ui-test/src/test/java/`**, `web-ui-test/src/main/java/com/sahibinden/web/client/**` (Pages/Layouts).
- **Build pattern / signatures / recipes:** §3, §5.

## 11. Deferred (later phases)

- **Jenkins / unattended:** safe-by-default **advisory** (open a PR, never merge), least-privilege CI token (no protected-branch push, no Jira), **server-side branch protection** as the real guarantee. *(Final phase — the commit-gate hook is a bypassable string match, not a wall.)* CODEOWNERS + Bitbucket branch-permission runbook drafted in [`enforcement-codeowners.md`](./enforcement-codeowners.md) — **INERT** in web-test (kit is gitignored, 0 tracked files); activates when the kit is committed to a tracked repo.
- **Worktree isolation:** apply each fix in a scratch git worktree (isolates code for concurrent / parallel-CI runs). *Not* needed for the single-user interactive loop — git + diff-review + never-commit already give reversibility; it earns its keep only under concurrency.
- **Form factor:** Hektor skill vs standalone toolkit vs portable-core+skill. *(The portable-core+skill
  form is realised: the `core/*.sh` engine runs from any terminal harness; Cursor support is wired
  (`.cursor/hooks/flaky-kit-self-protection-gate.sh` + rule), and the cross-harness gradient + recipe for
  other LLMs is documented in [`cross-harness.md`](./cross-harness.md). The shared `core/shell-guard.py`
  is the write-once surface-write detector used by both the Claude and Cursor gates.)*
- **Toggles:** diff-preview-before-apply, control-box health check, defect evidence bundle.
- **Multi-stack adapter (Cypress / non-Gradle) — PARKED.** Run the kit against `admin-e2e-cy` (Cypress, JS/TS)
  and other non-Selenium suites. Reusable as-is: the loop + safety, `apply` (set `source_roots` to `cypress/e2e`),
  `cluster`/`summary`/`ledger`, sanitizer, gate, lock-kit, install/cross-harness. Needs adapting: `ingest`
  (Cypress result source — Cypress Cloud / Currents / Sorry-Cypress / mochawesome|junit XML) and `rerun`
  (`npx cypress run --spec … --reporter …` + a new output parser; "rerun N× to confirm real-vs-flaky" is
  unchanged); `compile` → `tsc --noEmit`/lint or no-op; `dom-capture` → Cypress's native screenshots/video.
  Clean design: extend the config seam to `run.kind: gradle-junit|cypress` + `report.kind: es|junit-xml|mochawesome|currents`
  (one engine, adapter selected by config) — preferred over forking a separate kit. **Prereq: investigate
  `admin-e2e-cy`'s reporter / result source / spec layout / CI before building the adapter (don't guess).**

## 12. Vulnerability register (seed — vuln-hunt starts here)


| Vuln                                                                                    | Mitigation                                            | Residual                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Stale build (number reuse)                                                              | pin by `@timestamp` (§3)                              | report re-index lag                         |
| Untrusted report → injection                                                            | I1                                                    | —                                           |
| Act on nonexistent/renamed test                                                         | I2                                                    | —                                           |
| Misclassify fix↔bug                                                                     | evidence-gate (§5.3) + I4                             | ambiguous cases → T4 (human)                |
| **Mask a real regression**                                                              | **I4**                                                | —                                           |
| Shared-layout silent break                                                              | green-proof widening (§4 step 4)                      | dynamic/runtime coupling not in static deps |
| Per-box confound                                                                        | I9                                                    | —                                           |
| Wrong-file / corrupt edit                                                               | I3                                                    | —                                           |
| Data/PII/secret leak                                                                    | I7                                                    | log scrubbing completeness                  |
| Runaway run / 15k-doc build                                                             | I6                                                    | —                                           |
| Double-apply on re-run                                                                  | I5 (re-derive from source)                            | —                                           |
| "Flaky" overloaded / time-shifted (flaky vs resolved-upstream vs data-drift vs per-box) | §2 + run on report's box + N-runs                     | report's box may be gone                    |
| Re-run side effects (payment/email/data) irreversible                                   | I8 (flag side-effecting tests)                        | inherent to verification                    |
| First-line misbuckets wrapped/MultipleFailures                                          | §5.1 root-cause clustering                            | obfuscated/empty traces                     |
| Heterogeneous cluster / unbounded re-clustering                                         | §5.1 homogeneity + I10 bound                          | —                                           |
| Determinism overclaimed (verdicts aren't)                                               | §2 qualifier + flaky-confidence                       | —                                           |
| Recipe over-fit (global side effects)                                                   | diff-preview + green-proof + recipe blast-radius flag | novel edge cases                            |
| Green-proof runs against shared tb/Selenoid/live-data (concurrency)                     | I10 (rev-pin) + tb exclusivity / N-run averaging      | shared-infra contention                     |
| qagent snapshot stale (golden selector outdated)                                        | verify vs current code + tb; advisory only            | snapshot lag                                |
| qagent golden selector is itself the brittle one                                        | use robust *sibling* selectors, not the golden        | no robust sibling exists                    |
| qagent semantic search imprecise                                                        | `where:{testName}` for exact; advisory only           | embedding drift                             |
| **RCE via `buildStartTime` → bash arith-eval `$((startMs/1000))` (V-1)**                 | **I1** digits-only validate before arithmetic (ingest.sh); `set -u` does NOT stop it | — (fixed 2026-06-30) |
| **I3 confinement bypass via non-canonical `../` path (V-2)**                             | **I3** realpath-canonicalize, then assert under realpath'd source_roots (apply.sh)    | — (fixed 2026-06-30) |
| **Silent ES truncation hides clusters > `size` (G-1)**                                   | read `hits.total`; loud warn + `truncated`/`failTotal` flags (ingest.sh)             | raise `size` to see all |
| **I6 cluster cap was dead config (LLM-discipline only) (G-2)**                           | enforce `bounds` in cluster.sh; keep ≥`per_cluster_keep_min`/sig; emit `dropped`     | — (fixed 2026-06-30) |
| **Committed summary leaked raw `sig` (stackTrace slice) (G-3)**                          | summary emits structured tokens (recipe/bucket/tier) only; `bucket` = exception TYPE | — (fixed 2026-06-30) |
| **`ledger set` raw jq-filter injection**                                                 | `--arg`/`--argjson` setter binds untrusted data as `$vars` (ledger.sh)               | — (fixed 2026-06-30) |
| **Standalone `dom-capture` left unscrubbed DOM (no GC)**                                 | self-GC sweep (>1 day) in dom-capture.sh                                             | — (fixed 2026-06-30) |


## 13. Packaging threat model (P1–P8) — the core + skill surface

§12 hardens the triage *logic*; wrapping it as a **core + skill + config + shared deploy** opens new surfaces.


| #      | Vuln                                                                                                                    | Mitigation                                                                                                                                               | Status                                 |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **P1** | Prompt injection via untrusted report / qagent / Confluence text into the LLM skill (fake an approval, force an action) | all external text is **data, never instructions** (delimit; show verbatim); human gates + never-commit/ticket/disable + diff-review cap the blast radius | design / SKILL.md                      |
| **P2** | Skill bypasses core invariants (runs gradle / edits directly, skips the clean-tree/diff discipline)                     | skill mutates **only via core**; SKILL.md routes all mutation through `core/`                                                                            | design / SKILL.md                      |
| **P3** | Config / recipe injection (ES host repoint = exfil; `source_roots:/` = I3 bypass; recipe-as-code)                       | validate config (host allowlist; roots resolve under repo); **recipes are data, never `eval`'d**; no secrets in config                                   | core                                   |
| **P4** | Kit not covered by — and can edit — its own safety surface                                                              | `hooks/flaky-kit-self-protection-gate.sh` (mirrors `enforcement-self-protection-gate`); `HEKTOR_FLAKYKIT_UNLOCK`                                         | **DONE+ (2026-06-30)** — gate now matches **Bash** too; `core/lock-kit.sh` adds an OS read-only wall; both keyed to `HEKTOR_FLAKYKIT_UNLOCK`. Deny **is** enforced by the current CLI (§14 META corrected). Bash-matcher registration in `settings.json` pending (`HEKTOR_HOOKS_UNLOCK`). |
| **P5** | Internal-infra disclosure when shared (ES/Selenoid/qagent/testbox/bean names)                                           | all endpoints in `config.json` (§10 seam); internal-only until genericized                                                                               | core                                   |
| **P6** | qagent absent/swapped + untracked tool supply chain in shared/headless runs                                             | qagent advisory + verify endpoint; pin/declare tool versions                                                                                             | core                                   |
| **P7** | Ledger poisoning / shared-state races                                                                                   | I5 (re-derive from source) + integrity + locking                                                                                                         | core                                   |
| **P8** | Works-on-my-box (jq/gradle/JDK/qagent-snapshot drift)                                                                   | pin prerequisites; snapshot-version qagent                                                                                                               | core                                   |


The scariest (P1) is capped by choices already locked: a fully-hijacked skill can still only **propose a diff a human reviews**.

## 14. Findings from live driving (s4-flaky-1232 / 1234)

These surfaced *only* by running the kit on real builds — they are the discipline that paper design missed:


| #        | Finding                                                                                                                                        | Mitigation                                                                                                                  | Status                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **N1**   | **"the run didn't run"** — gradle served `:test FROM-CACHE` ⇒ 0 tests executed ⇒ a **silent false verdict** (the scariest mode for a verifier) | `test --rerun-tasks --no-build-cache`; `runs_with_tests`/`incomplete_runs`/`run_anomalous` guards                           | fixed; guards new/lightly-tested |
| **N2**   | **DOM-blind fix authoring** (V1 reborn) — without the rendered DOM, a selector fix could mask/mis-fix                                          | `**dom-capture` step** (the gap) + I4 bias-to-🐛 (stop, don't guess)                                                        | **PROVEN tb128 2026-06-22** — `dom-capture.sh` + `PageDomCaptureTest`: 385 KB rendered DOM, 14 `_cllpsID_a…` filter ids via `getPageSource()`; **kit-sourced** via `capture.init.gradle` init-script — zero suite footprint (CSS-scope skill-side). **Flow-gated breaks** (payment/posting/flag, unreachable by URL) → `dom-on-failure` + `DomDumpOnFailure` (AfterTestExecution dump) **proven tb161 2026-06-23** |
| **N3**   | **ticket text as injection** (extends P1) — `correlate` feeds Jira summaries/descriptions to the LLM                                           | data-not-instructions; `correlate` is **read-only** (I8)                                                                    | design                           |
| **N4**   | **kept rerun logs unscrubbed** — raw stackTraces/PII in `/tmp` (the price of keeping causes)                                                   | GC >1d + local-transient + **never ship**; only the truncated `cause` reaches shared artifacts                              | mitigated                        |
| **N5**   | `**jiraTicket` is build-level** — tags *every* failing test ⇒ a FALSE per-cluster signal                                                       | reweight on the ticket **scope** (description + **ALL linked tickets**, one hop), not the bare tag                          | fixed (`correlate`)              |
| **N6**   | **driver drifted heavy** — raw-exception clusters, tooling narration (build ids / run anomalies / rerun+dom mechanics / task ids), and per-item approval stops made the loop hard to read & track (the kit made a simple pre-kit flow *worse*) | re-group clusters **by meaning**, **ONE** easy→bug table, **two gates only**, no tooling narration, execute end-to-end between gates (§4 *Keep it simple* + SKILL *Presentation discipline*) | fixed 2026-06-25 (user feedback on s4-flaky-1394) |
| **META** | **CORRECTED 2026-06-30: PreToolUse `deny` IS enforced by the current CLI.** Observed live this session — an `enforcement-self-protection-gate` deny BLOCKED a `settings.json` Edit (file unchanged, tool error returned). The earlier "denies aren't enforced" claim is superseded; the gates are real walls when locked, not only audit signals. | kit gate **logic verified 2026-06-25** (deny on `core/**` + `SKILL.md`; allow + `.hook-audit.log` entry on `HEKTOR_FLAKYKIT_UNLOCK=1`; passthrough otherwise) → enforces wherever the CLI honors PreToolUse. A `chmod -w` wall is now ADDED as defense-in-depth (`core/lock-kit.sh`), and the in-process deny is honored by the current CLI — so the gate itself walls too (revising the original *friction, not a wall* stance, §13 P2/P4). | **corrected** — deny honored live; gate extended to Bash; chmod-lock helper added. Caveat: the kit is **gitignored** in web-test (0 tracked files), so CODEOWNERS/branch-protection are INERT until it lands in a tracked repo (see `enforcement-codeowners.md`). |


