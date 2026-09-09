---
name: hektor-work-summary-deck
description: >
  Generate a branded HTML deck (optionally rendered to PDF) summarising
  Hektor's QA output — new test classes, methods added, coverage growth,
  adversarial findings, bug ledger, VRT changes — for stakeholders and
  managers. Reads docs/hektor/run-status.json, journey-map.md,
  adversarial-findings.md, and the git log since the last deck. Triggers
  on "generate the QA report", "summary deck", "export the work
  summary", or "show what we've shipped". Opt-in only — never
  auto-activates.
disable-model-invocation: true
---

# Hektor work summary deck

A single HTML deliverable (optionally → PDF). Stakeholder-facing.
Read in 5 minutes; understand what Hektor shipped.

Not a test result report (`gradle test --info` already does that). Not a
test catalogue (that's `hektor-test-catalogue`). This is the
shippable-work narrative.

---

## Inputs

- `since: <date | commit | ref>` — when the work began. Default: the
  most recent prior deck's date, or the last 7 days if no prior deck.
- (Optional) `scope: <Kure or domain>` — narrows the report.

---

## Procedure

### 1. Gather

From `docs/hektor/run-status.json`:
- Run mode used.
- Phases completed.
- Approved deviations.

From `docs/hektor/journey-map.md` (if present):
- Total journeys mapped.
- Priority breakdown.
- Coverage status (journeys with at least one test class).

From `docs/hektor/adversarial-findings.md`:
- Findings by severity.
- Regression specs landed.
- App bugs filed.

From `git log --since=<since>`:
- Commits matching `^SHBDN-` or `^WEBT-` (the team's one-line key
  convention),
  `^docs(hektor):`.
- Files touched per commit.

From the suite:
- `find web-ui-test/src/test/java -name '*Test.java' -newer <since>` —
  new test classes.
- `gradle test --info | tail -50` — last green run summary, if
  available.

### 2. Author the deck

`docs/hektor/qa-summary-deck.html`. Single-file HTML with inline CSS,
brand-neutral but readable. Sections:

1. **Cover**
   - Project: `sahibinden/web-test`.
   - Period: `<since>` → today.
   - Hektor protocol used.

2. **Scorecard**
   - New test classes: N.
   - New test methods: M.
   - Journeys covered: X of Y mapped.
   - Adversarial findings: A (with severity split).
   - Regression specs landed: R.
   - Bugs filed: B.
   - VRT baselines added/refreshed: V.

3. **Coverage growth by Kure**
   - Bar chart (inline SVG) of test count per Kure: before / after.

4. **Adversarial findings (top 5)**
   - Severity, description, disposition.

5. **Bug ledger**
   - Open bugs with `@ScheduledDisable` tests linked.
   - Closed bugs with re-enabled tests.

6. **VRT baseline changes**
   - From `docs/hektor/vrt-baseline-changes.md`.

7. **Deferred / blocked**
   - Journeys deferred with reasons + authorizers.
   - Disabled tests with bug IDs.

8. **Pointers**
   - `docs/hektor/journey-map.md`
   - `docs/hektor/adversarial-findings.md`
   - `docs/hektor/test-catalogue.md` (if present)
   - Git log range.

### 3. Render PDF (optional)

If the caller asks for PDF, use the team's HTML→PDF pipeline (Chromium
headless print is fine if no other tool is set up). Drop next to the HTML:

```
docs/hektor/qa-summary-deck.html
docs/hektor/qa-summary-deck.pdf
```

---

## Style rules

- Single file. No external assets. Inline CSS, inline SVG, inline
  charts. The deck must open offline.
- Brand-neutral. No client logos unless the user explicitly drops one in
  via `docs/hektor/brand/`.
- Numbers are calibrated — don't claim "100% coverage" unless the journey
  map says every journey has a passing test class. Use "X of Y journeys
  covered" instead.
- Honest about deferrals. The "Deferred / blocked" section is not
  optional. Stakeholders see ALL deferrals with their authorising
  quotes.
- Honest about bugs. Open bugs are listed with the disabled test count.
  Don't silently hide them.

---

## Refusal cases

- Caller asks for a deck without specifying `since:` and the repo has
  no prior deck. Ask: "Since when? Default is 7 days. OK?"
- Caller asks for metrics Hektor didn't track (e.g., "include the
  business KPI from <external system>"). Refuse or redirect — Hektor's
  scope is what's in this repo + its ledgers.

---

## Return shape

```json
{
  "handover": {
    "role": "hektor-work-summary-deck",
    "status": "deck-rendered",
    "next-action": "share"
  },
  "period": { "since": "2026-04-21", "until": "2026-05-21" },
  "scope": "whole-suite",
  "deliverables": {
    "html": "docs/hektor/qa-summary-deck.html",
    "pdf": "docs/hektor/qa-summary-deck.pdf"
  },
  "scorecard": {
    "new-test-classes": 18,
    "new-test-methods": 47,
    "journeys-covered": "32/41",
    "adversarial-findings": 6,
    "regression-specs": 4,
    "bugs-filed": 2,
    "vrt-changes": 3
  },
  "summary": "Monthly deck rendered; 18 new test classes, 47 methods, 9 journeys still uncovered."
}
```
