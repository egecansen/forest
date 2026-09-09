---
name: hektor-from-jira
description: >
  Ticket-driven test authoring: take a Jira ticket ID, fetch the ticket
  + one hop of linked tickets via the Atlassian MCP, distil the
  acceptance criteria into a minimal scenario list, route each scenario
  to the right existing *Test.java class (or a new one), compose the
  tests, run them, and batch-surface any proposed fixes for human
  approval before applying. Triggers on ANY prompt that names a single Jira
  ticket of this org (SHBDN-*, WEBT-*, RAL-*, TDC-*) — including a bare
  https://jira.sahibinden.com/browse/<KEY> URL on its own, with or without a
  trailing testbox such as "- tb39" / "tbx39" (that suffix names the reserved
  box to run on, it does NOT mean flaky-triage). Also "work <TICKET-ID>",
  "automate WEBT-XXX", "Hektor, do <ticket>", "write tests for the ticket",
  "<KEY> - tb<NN>", or when hektor-orchestrator routes a ticket-driven entry.
  A Jira URL always routes here, never to hektor-flaky-triage.
---

# Hektor from Jira — ticket-driven test authoring

A single Jira ticket goes in. A reviewed plan and validated test methods
on the correct classes come out — left as uncommitted changes for the user
to review and commit themselves (the skill never commits). Human approval
gates the plan AND the fix batch — no code edits land without explicit
"go".

This skill orchestrates existing Hektor skills under a tighter protocol
designed for daily ticket work. It does NOT replace
`hektor-coverage-expansion` (that's the broad sweep) or
`hektor-test-composer` (that's the per-journey atom). It owns the
ticket → scenario → composer dispatch flow.

---

## Required tools

The Atlassian MCP (`mcp-atlassian` by sooperset) must be registered in
`.cursor/mcp.json` (or globally in `~/.cursor/mcp.json`). The package exposes
snake_case tool names; the host surfaces them prefixed with the server name
from the MCP config (`Atlassian` in the user's setup). So the callable tools
are:

- `mcp__Atlassian__jira_get_issue` — fetch a ticket by key.
- `mcp__Atlassian__jira_search` — JQL search (used to follow links when
  the issue payload doesn't already include them).
- `mcp__Atlassian__jira_get_transitions` — read available statuses
  (informational; Hektor doesn't transition tickets automatically).
- `mcp__Atlassian__jira_add_comment` — available but **never called by this skill**.
- `mcp__Atlassian__confluence_search` / `..._get_page` — optional, when
  the ticket references a Confluence design doc.

(Tool names follow the upstream `mcp-atlassian` schema; the prefix comes from
whatever you named the server in `mcp.json`. If it differs from `Atlassian`,
discover the actual names from the tool list once at session start — the
underlying snake_case names are stable.)

If the MCP isn't loaded, refuse and tell the user to enable it.

---

## Inputs

The caller passes:

- `ticket: <KEY>` — e.g., `WEBT-245156` or `SHBDN-251200`.
- (Optional) `scope-override: <free text>` — narrows or expands the AC
  interpretation (e.g., "skip the mobile variant, mobile tests come in a
  follow-up ticket").
- (Optional) `link-depth: 1 | 2` — how far to walk linked tickets.
  Default `1` (one hop). `2` is rarely useful and burns context.

## Testbox precondition

This skill runs tests, so the orchestrator's testbox precondition
applies. Before Phase 6 (compose), confirm `docs/hektor/run-status.json`
has a populated `testbox` block. If not, refuse and ask the user
which testbox they have reserved (ID + data centre). All `gradle test`
commands dispatched downstream (via `hektor-test-composer` in
`stop-on-failure` mode and the post-fix re-runs in Phase 9) inherit
these values from the ledger.

---

## Procedure

### Phase 1 — Ingest

0. **Resolve "CI -" / automation wrapper tickets to the real task FIRST.**
   Tickets whose summary starts `CI - ` (and, in this org, `Tech Feature`
   issues labelled `*_automation`, e.g. `arama_automation`) are **automation
   task tickets**, not the feature itself. Their description is usually just
   a URL/key pointing at the main Story, or the main task is a `tests` /
   `tested by` linked issue. When the caller passes a `CI -` ticket: read its
   description + links, identify the main task, fetch THAT, and ingest the
   main task's title/description/AC. Keep the CI- key for the commit/branch
   trail, but the scenario seed comes from the main task. (Conversely, when
   the caller passes the main Story, note its `tested by` CI- ticket — that
   is the automation ticket the work fulfils.)
1. Fetch the ticket via the Atlassian MCP. Pull:
   - **Title**, **type** (Bug / Story / Task / Sub-task), **status**.
   - **Description** body (often Turkish; preserve verbatim).
   - **Acceptance Criteria** (often a numbered list in the description
     or in a separate AC field).
   - **Components**, **labels**, **fix versions**.
   - **Linked issues** with link type (`blocks`, `is blocked by`,
     `relates to`, `duplicates`, `caused by`, `clones`).
2. Cache the raw ticket JSON at
   `docs/hektor/jira/<TICKET>/raw-ticket.json` (gitignored — see
   `docs/hektor/.gitignore`).
3. If the ticket type is `Bug`, note the reported reproduction steps and
   the "expected vs observed" — those are likely scenario inputs.
4. If the ticket type is `Story` / `Task`, treat the AC as the scenario
   seed.

### Phase 2 — Walk relations (one hop)

For each linked issue:

- `is blocked by` (status open) → blocker; surface to the user, do NOT
  compose tests that depend on the blocker's behaviour until it's
  resolved.
- `blocks` → downstream effect; note for the plan ("tests written here
  unblock TICKET-Y").
- `relates to` / `clones` / `caused by` → context; fetch a one-paragraph
  summary, attach to the plan.
- `duplicates` → if the duplicate is **closed**, the AC may already be
  covered by a prior test. Search the suite for any `@Description`
  matching the duplicate's title before composing.
- `tests` / `tested by` → the web/native automation (CI-) ticket linkage;
  this is the ticket the test work fulfils. Carry its key for the trail.

**ALWAYS read any linked / subtask "Test Onay" ticket of the main task.**
Issue type `Test Onay` (e.g. "TEST Süreci Onay Taskı") is the QA test-process
approval task. It is the authoritative source for the *manual* test
scenarios that were actually run, and frequently reveals the trigger /
eligibility conditions and exact UI a pure-DOM probe can't (a feature gated
by usage limits, eligibility, or a separate flag won't render in a naive
flow). Pull from it:
  - **Description** — usually a link to the test-management run
    (`…test-management…/test-runs/progress?id=NNN`); the run's case list is
    the scenario seed. (If the link is an internal SPA you can't fetch,
    surface the URL + run id to the user and ask for the case export.)
  - **Attachments** — download via `jira_download_attachments` and VIEW them;
    they are the manual evidence (the real survey/modal/screen + its
    trigger). Caveat: attachments can be unrelated generic test evidence —
    confirm each actually depicts THIS feature before relying on it.
  - **Proforma forms** — `jira_get_issue_proforma_forms` *if it works*: on
    jira.sahibinden.com (Data Center) it returns
    `Forms API requires a cloud_id`. Treat a failure here as "no forms",
    not as a blocker.

**ALSO read the ticket's own "Test" tab.** The issue screen carries named
field tabs — `Field Tab | DevOPS | Time Spent | Test` — and the Test one is a
first-class scenario source that is easy to miss because it is not the
description. Fetch it explicitly (the fields are not in the default set):

```
jira_get_issue(issue_key=<KEY>, use_display_names=true, fields=
  "customfield_10891,customfield_14420,customfield_18194,customfield_14419,
   customfield_20090,customfield_16200,customfield_16201,customfield_22418,
   customfield_21496,customfield_14802,customfield_10070,customfield_17899,
   customfield_19691,customfield_10908,customfield_21190,customfield_14900,
   customfield_10894")
```

- **`Test Document` (`customfield_10891`) is the one that carries weight.**
  When populated it is a full QA-authored test doc, and it is usually more
  concrete than the ticket description: an `*On Kosullar*` block (often with
  the exact DDL/SQL the feature needs), then numbered tests grouped by
  surface, each with steps and an explicit `*Beklenen:*`. Verified example:
  SHBDN-232070 — 7 tests split into `ADMIN PANEL TESTLERI` and
  `FRONTEND TESTLERI (Desktop & Responsive)`, including a fallback case.
- The siblings (`Test Cases`, `Test Risk Analizi`, `Selenium Tests`,
  `Resource Tests`, `Test Case Sayısı`, `Manuel test edilsin`, `TestBox`,
  `Preprod Result Test`, `QA Testers`, `Test Fail Count`) are on the same tab
  but are empty on most tickets. Read them, don't depend on them.
- **The Test tab does not replace the `Test Onay` hop, and vice versa.** The
  Test Document is the *planned* scenario set; the `Test Onay` child is what
  was *actually run*, with pass/fail per case. Read both when both exist.

How the Test Document's own headings route the work — do not flatten them:

| Section / marker | What it means for this suite |
|---|---|
| `ADMIN PANEL TESTLERI` | Admin surface — **not** web-ui-test. Belongs to the Cypress admin suite; report it, don't author a Selenium test for it. |
| `FRONTEND TESTLERI (Desktop & Responsive)` | Both surfaces get tests: `website` AND `responsivesite`. |
| `*On Kosullar*` with SQL/DDL | A data precondition. Seed it — exhaust the TDC endpoints and `/functionalTest/*` before any DB write (auto-memory `prefer-endpoint-seeding-over-db-writes`), and never skip-guard the test instead of seeding (`seed-data-over-skip-guard-for-gated-tests`). |
| A language/`Ingilizce` case | The method needs `@Tag(CommonTag.LANGUAGE)`, or the EN run skips it (auto-memory `en-runs-require-language-tag`); route via `hektor-write-language-test`. |
| A fallback / empty-value case | Usually the highest-value assertion in the doc and the one most often missing from the suite. Do not drop it as an "edge case". |

Cap at 5 linked issues fetched. If more, list them and ask: "There are
12 linked issues. Which are load-bearing for the AC?" Don't auto-walk a
big graph.

### Phase 3 — Distil scenarios + write plan

Translate the AC into a minimal scenario list. Be aggressive about
folding variants into `@ParameterizedWebTest` and `State variations` —
the ticket usually only needs the happy path + 1-2 edge cases, not the
full P0 portfolio.

**Reuse, don't create. Minimize, don't enumerate.** Two hard rules:
- **No new test class when a related one exists.** Find the closest existing
  class via qagent `testlist` (semantic) + a live-repo `@Description` /
  package grep, and **extend it**. Only create a new `*Test` class when no
  related class covers the journey/domain. This applies per surface
  (website + responsivesite each). A native-only match is NOT a reusable
  web class — but still prefer the existing web class for that domain.
- **Fewest methods that still cover every AC.** Prefer extending or
  parameterizing an existing method over adding a new one; collapse several
  ACs into one end-to-end method when they share a flow (e.g. close →
  assert dismissed → re-enter → assert not-shown-again is ONE method, not
  three). Add a method only when a scenario can't fold into an existing one
  without losing coverage or readability. State the AC→method mapping in the
  plan so coverage is auditable despite the smaller method count.

Write `docs/hektor/jira/<TICKET>/plan.md`:

```markdown
<!-- hektor:jira-plan -->
# Jira Plan — WEBT-245156

**Ticket:** WEBT-245156 — "Hybrid search filter tooltip metni güncelle"
**Type:** Story
**Reporter:** ...
**Status:** In Progress
**Components:** Search
**Generated:** 2026-05-21T16:00:00Z

## What the ticket asks for
[2-4 sentence summary in the ticket's primary language — Turkish if
the ticket is Turkish, English if it's English.]

## Acceptance criteria → scenarios

| AC | Scenario | Surface(s) | Target test class | New or extend |
|---|---|---|---|---|
| 1. Tooltip metni "Yenilenmiş filtre" olarak güncellenmeli | tooltip metin doğrulaması | website | HybridSearchFilterTest | extend (add method) |
| 2. Mobilde de aynı metin görünmeli | mobile tooltip metin doğrulaması | responsivesite | ResponsiveHybridSearchTest | extend |
| 3. Tooltip ikonu hover edildiğinde tooltip görünmeli | tooltip hover davranışı | website | HybridSearchFilterTest | extend |

## Linked context

- **relates to** WEBT-245100 (closed): prior tooltip refactor — covered by
  `HybridSearchFilterTest#testOpenLeftMenuList`. New scenarios extend
  that class.
- **blocks** WEBT-245200: mobile QA sign-off — landing AC #2 unblocks it.

## Deliberately NOT covered (scope decisions)

- Visual regression baseline refresh — not requested in this ticket;
  separate ticket would dispatch `hektor-visual-regression`.
- EDR contract update — no EDR change implied in the AC.
- The 5 other filter tooltips in the section — ticket scope is just the
  refresh-on-click tooltip; covering them is `hektor-coverage-expansion`,
  not this ticket.

## Suggested tags (per `hektor-conventions`)

```java
@Tags({
  @Tag(MainTag.PARALLEL),
  @Tag(MainTag.READ_ONLY),
  @Tag(MainTag.PRODUCTION),
  @Tag(Kure.SEARCH),
  @Tag(SearchDomain.HYBRID_SEARCH),
  @Tag(SearchDomain.FILTER_SEARCH)
})
```

## Java targets

- `ui.website.search.hybridsearch.HybridSearchFilterTest` (+3 methods)
- `ui.responsive.search.ResponsiveHybridSearchTest` (+1 method)

## Layout work expected

- Add `LeftFilterLayout.getTextTooltipText()` if not already generated.
- Mirror in `ResponsiveSearchResultFilterLayout`.

## Risks / open questions

- AC #3 says "hover" — does mobile have a tap-equivalent? If so, AC #2's
  scenario needs a tap-then-assert variant. Will surface in plan-review.
```

### Phase 4 — **Plan approval gate** (HUMAN)

Surface the plan path to the user:

> Plan written to `docs/hektor/jira/WEBT-245156/plan.md`. 3 scenarios
> across 2 surfaces; extends 2 existing test classes; expected 1 new
> layout method. Review the plan and reply **go** to proceed, **edit
> <N>** to adjust a row, or **stop** to abort.

Wait for explicit "go". Don't proceed on inferred approval. Don't
proceed because the user said something positive about a different
topic.

If the user edits the plan inline ("drop AC #3, that's a separate
ticket"), update the plan file, surface the diff, ask again.

### Phase 5 — Map to existing classes

For each scenario:

1. Grep the suite for `@Description` matches in the same Kure/domain.
2. Find the closest existing test class (by package path + tags).
3. If `docs/hektor/journey-map.md` exists and the scenario maps to a
   journey block, prefer that block's `Java targets (suggested):`.
4. Confirm the target class can take a new method (verify it doesn't
   already test the same AC).

Decisions land in the plan's "Target test class" column. If a target
turns out wrong at this stage (e.g., the existing class is SERIAL but
this scenario should be PARALLEL), surface and ask before creating a
new class.

### Phase 6 — Compose

Dispatch `hektor-test-composer` per scenario with:

```
journey: <scenario-slug>
surface: website | responsivesite
mode: stop-on-failure        ← important: do NOT auto-fix in jira mode
ticket-context: SHBDN-245156 (or WEBT-245156 if no SHBDN equivalent)
target-class: <FQCN>
plan-row: <row index in plan.md>
description-prefix: "SHBDN-245156 - "
```

The `description-prefix:` tells composer to start each new test method's
`@Description("...")` with the SHBDN key, matching the team's convention
(verified from existing tests like
`ResponsiveFavoriteClassifiedTest#testFavoriteBulkDelete` which uses
`@Description("SHBDN-111023 - Favori İlan Listesinde Toplu Silme
Yapılabilmesi - Responsive")`). The description body itself remains
free-text (typically Turkish for this repo).

`mode: stop-on-failure` is the new flag (see
`hektor-test-composer` §"Modes"). Under this flag, composer writes the
test, runs it once on Selenoid + local, but does NOT auto-dispatch
`hektor-failure-diagnosis` on failure. Instead it returns the failure
unfixed for batching here.

If the scenario needs a new layout method, composer transparently
dispatches `hektor-page-authoring` first — that's unchanged.

### Phase 7 — Collect outcomes

After all composer dispatches return, classify:

- **Green** — test method landed, passes both envs. Ready to commit.
- **Failed** — test method landed but is RED. Failure details captured.
- **Blocked** — composer couldn't even write the test (missing layout
  with unresolvable DOM, ambiguous AC). Needs a clarification round.

### Phase 8 — **Batch fix-approval gate** (HUMAN)

For each failed test, dispatch `hektor-failure-diagnosis` in
`mode: propose-fix` (see that skill's §"Modes"). Diagnosis returns:

- Root-cause classification.
- Proposed file edits as a structured diff (NOT yet applied).
- Confidence (high / medium / low).

Aggregate all proposed fixes into
`docs/hektor/jira/WEBT-245156/proposed-fixes.md`:

```markdown
<!-- hektor:jira-proposed-fixes -->
# Proposed fixes — WEBT-245156

3 tests failed, 3 fixes proposed. Reply with one of:
- **apply all** — apply every proposed fix.
- **apply 1,3** — apply only the listed fixes.
- **reject all** — discard all; ticket work pauses for manual review.
- **reject 2; apply 1,3** — partial.

## Fix 1 (confidence: HIGH) — HybridSearchFilterTest#testTooltipText

**Failure:**
`org.openqa.selenium.NoSuchElementException: tooltipText`

**Root cause:** layout selector `.tooltipText` no longer matches; product
PR-4022 renamed the class to `.tooltipText-v2`.

**Evidence:** Selenoid VNC video frame at t=4.2s shows the element
present with class `.tooltipText-v2`; page-source confirms.

**Proposed diff:**

```diff
--- a/client/website/layout/search/hybridsearch/LeftFilterLayout.java
+++ b/client/website/layout/search/hybridsearch/LeftFilterLayout.java
@@ -120,7 +120,7 @@ public class LeftFilterLayout extends PageFacility<LeftFilterLayout> {
   @GenerateMethods(getText = true, isDisplayed = true)
-  @FindBy(css = ".tooltipText")
+  @FindBy(css = ".tooltipText-v2")
   private WebElement tooltipText;
```

## Fix 2 (confidence: MEDIUM) — ...

## Fix 3 (confidence: LOW) — ...
```

Surface the file path and wait. Don't paraphrase the diffs in chat — make
the user read the file. Diffs in chat get glossed over; diffs in a doc
get read.

### Phase 9 — Apply approved fixes

Apply only the diffs the user approved. For each:

1. Edit the file.
2. Re-run the affected test on Selenoid + local.
3. If it's now green → keep the edit.
4. If it's STILL red → revert the edit, surface to user:
   "Fix 1 didn't resolve the failure. New failure signature: <...>.
   Stop, re-diagnose, or escalate?"

For rejected fixes:
- Park the corresponding test method with the team's `@ScheduledDisable`
  annotation (from `com.sahibinden.web.annotation.disable`), e.g.,
  `@ScheduledDisable(startTime = <epoch-ms-3-days-out>, reason = "Bug
  mevcut - SHBDN-<bug-id> — Hektor fix proposed but rejected at <date>,
  awaiting manual review")`. The startTime gives the team a 3-day window
  before the test auto-resumes attempting; pick the actual bug ticket
  key, not the originating ticket key, if a separate bug was filed.
- List in the ticket comment so reviewers see it.

### Phase 10 — Wrap-up (the user commits, never the skill)

**NEVER run `git commit` or `git push`.** The user reviews every diff and
commits themselves — always. Do not commit after tests go green, do not
commit "as the natural final step", and do not commit to "durably place
files on a branch." This holds even if the user types "commit": treat that
as permission for *them* to commit, surface the files and the suggested
message, and let them run it — confirm before you ever touch `git commit`.
There is no skill-driven path that ends in a commit.

This is a standing user rule (recorded in auto-memory `never-commit`),
established after the skill committed SHBDN-243819 unasked during a
branch-move. Stop at staged / working-tree changes and hand off.

**Moving work to the right branch without committing.** The repo is a
single shared working tree (concurrent Hektor sessions may have unrelated
edits in it — e.g. a parallel `hektor-test-repair` run). To land this
ticket's files on `tech/WEBT-<key>` without committing and without
disturbing other sessions' edits, use `git stash push -- <only your
files>`, `git checkout tech/WEBT-<key>`, `git stash pop` — leaving the
result as uncommitted changes for the user to review. Never sweep another
session's modified files into your scope.

**Never post a comment to the Jira ticket.** Do not call
`jira_add_comment` at any point during this skill — not automatically,
not as a final step, not unless the user explicitly says "post a comment
to Jira" in the current chat.

**Commit message convention — to *suggest* to the user, not to execute.**
When you surface the ready files, also surface the message the user should
use. This team's convention (verified from `git log`): commits are one
line, the ticket key, that's it — NOT conventional-commits
(`test(...): summary`) format. One commit per landed scenario, plus a
separate commit per layout edit. Branch carries the WEBT key; each commit
carries the matching SHBDN key:

- Branch (created up-front): `tech/WEBT-245156`
- Each commit message: `SHBDN-245156` (one line, no body)
- PR title: `Pull request #NNNN: Tech/WEBT-245156` (Bitbucket auto)

Multiple identical `SHBDN-245156` commits on one branch is normal.

If the ticket only has a WEBT key (no matching SHBDN), use the WEBT key
in the commit message. If a separate bug ticket was filed during the work,
use that ticket's key for the fix commits.

---

## Refusal cases

- Atlassian MCP not available. Refuse; tell user to enable it.
- Ticket key doesn't match the repo's known prefixes (WEBT / SHBDN /
  others). Ask which prefix is correct.
- Ticket has no AC and no description. Refuse; ask for the
  acceptance criteria.
- Ticket is blocked by an open issue. Surface the blocker, ask whether
  to proceed anyway.
- The AC implies a test that requires a credential the framework can't
  self-mint (admin role, paid plan). Surface; ask for the credential
  approach.
- The user said "go" but the plan path has been edited since you wrote
  it (file mtime newer than your write). Re-read, confirm what changed,
  ask again. Don't run on stale approval.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-from-jira",
    "status": "ticket-complete | partial-with-disabled | blocked",
    "next-action": "ship or revisit-with-product"
  },
  "ticket": "WEBT-245156",
  "ac-count": 3,
  "scenarios-composed": 3,
  "scenarios-green": 3,
  "scenarios-disabled": 0,
  "layout-methods-added": 1,
  "fixes-proposed": 1,
  "fixes-approved": 1,
  "fixes-applied": 1,
  "fixes-rejected": 0,
  "committed": false,
  "files-ready-for-user-to-commit": ["client/.../FooLayout.java", "ui/.../FooTest.java"],
  "suggested-commit-message": "SHBDN-245156",
  "ticket-comment-posted": false,
  "plan-path": "docs/hektor/jira/WEBT-245156/plan.md",
  "proposed-fixes-path": "docs/hektor/jira/WEBT-245156/proposed-fixes.md",
  "summary": "WEBT-245156: 3 ACs covered by 3 tests, 1 selector fix applied; all green."
}
```
