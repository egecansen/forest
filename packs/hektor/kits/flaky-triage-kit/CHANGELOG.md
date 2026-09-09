# Changelog

Every published version is a `.tgz` a project may be pinned to, so "which kit am I on, and
does it have the fix?" has to be answerable without diffing tarballs. It was not, for five
releases. It is from here on.

Format: newest first. Each entry says what changed for **a driver or an operator** — engine
refactors that change no behaviour are not entries.

---

## 1.0.10

### Fixed

- **The ledger could be committed.** `ledger.sh path` writes to `<repo>/.hektor/`, inside the
  repo, and nothing ignored it — so a `git add -A` put run state into someone's PR, in a kit
  whose entire discipline is never to commit anything. The directory now ignores itself
  (`.hektor/.gitignore` containing `*`), which touches no tracked file, needs no cooperation
  from the project's own ignore conventions, and is written once so a deliberate edit survives.

---

## 1.0.9

### Fixed — verdict correctness

- **Verdicts are keyed on the FQCNs the caller asked for.** Gradle prints
  `ClassName > method()` with no package, so the parse could only ever key on the simple name —
  while the ledger keys on FQCNs and `gate.sh` passes those keys straight through as
  `candidate_id`. Every consumer was left holding `FooTest.a` where it needed
  `com.x.FooTest.a`, and **two same-named classes in different packages merged into one
  verdict**. `rerun.sh` now maps back using the caller's own request list. When two requested
  FQCNs share a simple name the log genuinely cannot tell them apart, so both are emitted,
  marked `ambiguous`, and forced inconclusive — an honest "could not tell" instead of one test
  being handed the other's result.
- **I9's broken-box protection now applies where verdicts are made.** It required a cluster of
  ≥5 tests, but a *picked* cluster is typically 1–3 — so a sick box failing all three was graded
  `rejected` ("still red, suspected app-bug") rather than `inconclusive`, pointing the operator
  at the wrong culprit. The size floor added nothing the box's own health probe was not already
  carrying.
- **Cluster narrowing actually narrows.** It compared the aggregate's keys on their FIRST
  dot-segment (`com` for `com.x.FooTest.a`) against each entry's LAST one (the method) — class
  names matched against method names, so nothing ever matched, every entry fell to
  default-keep, and the optimisation silently did nothing and said nothing about it. Both
  sides now read the class.
- **"Could not measure the box" is no longer the same as "the box is sick."** `(.rate // 0) >= 0.8`
  collapsed both into `false`. Health is now tri-state and `broken_box_suspected` requires
  *measured* ill health — without that, a setup where the ES aggregation returns nothing would
  call every all-fail cluster a broken box, and no real failure could ever be confirmed. The new
  `box_health_known` field makes the difference visible rather than silent.

---

## 1.0.8

### Fixed

- **The running commentary was written for the engine, not the operator.** A real line read
  "the kit's sanctioned I9 box-health runs inside the confirmation rerun" — `I9`, `box-health`
  and `sanctioned` name nothing the reader knows, and the sentence is no more parseable in
  English than in Turkish. Both adapters now say that the short lines between tool calls are
  most of what the operator sees while you work, and must say what is happening in a
  teammate's words rather than the kit's internal vocabulary.

---

## 1.0.7

> **Version hygiene.** `1.0.6` was rebuilt several times during development as its contents grew
> — same number, different bytes, which is exactly what a version is supposed to prevent. The
> console's kit-sync compares by content hash (not by version), so it still installed each
> rebuild correctly; but "which kit am I on" stopped being answerable from the number alone.
> This entry ships as **1.0.7**, built once, and any `1.0.6` in a library should be treated as a
> development artifact.
>
> **1.0.5 is not this work either** — it was packed from the LIVE kit tree on 2026-08-07 via the
> console's "update package" button, which builds from `kitSourcePath`, while this work sat in
> the `-next` copy.

> **1.0.5 is not this work.** A `1.0.5` was packed from the LIVE kit tree on 2026-08-07 (via the
> console's "update package" button, which builds from `kitSourcePath`) while this work sat in the
> `-next` copy. That artifact carries none of the changes below, and the version number is spent.
> Everything described here ships as 1.0.6.

The theme is one process, stated once. The kit's own vocabulary had drifted between its
scripts and its drivers, and every driver had reverse-engineered a slightly different
version of the contract.

### Added

- **`core/process.json`** — the canonical process definition: phases (with order, label and
  meaning), cluster statuses (with transitions, terminal-ness and re-openability), buckets,
  tiers, and the ledger path convention. Closed enums live here now and are copied nowhere.
- **`INTEGRATION.md`** — the contract with any driver: what a caller must provide, what it
  may rely on, exit codes, trust boundaries, and a checklist for a new driver. Previously
  undocumented; every driver had guessed, and each had guessed something different.
- **`ledger.sh path <build>`** — resolves `<repo>/.hektor/ledger-<build>.json` and creates
  the directory. `$HEKTOR_LEDGER_DIR` overrides the location. The kit imposed no convention
  before, so every caller invented one — two real runs against the same build wrote two
  ledgers to two paths and neither driver could see the other's.
- **Rounds.** `run.round` on the ledger, `ledger.sh round` / `round-next`, and a `round`
  stamped on each cluster when it is first proposed (never restamped). This is I10's
  missing half — `bounds.max_rounds` (default 12) now actually bounds re-clustering, which
  matters more since terminal clusters became re-openable and "every cluster reaches a
  terminal status" stopped being a natural terminator. It also gives a driver the marker it
  needs to render rounds it did not watch happen.
- **`core/tests/run-all.sh`** — the whole suite in one command, with name filtering and
  `--list`. Fifteen suites and 1,331 assertions previously ran only when someone wrote the
  for-loop by hand, which is how a real failing guard sat unnoticed.
- **`ledger.sh cluster-cause <id> <fqcn> "<one line>"`** — why THIS test failed, as opposed to
  why the cluster exists. A cluster's `detail` explains the shared root cause; it cannot say why
  one member timed out where its sibling threw NoSuchElement, so a four-test cluster rendered as
  four near-identical rows and telling them apart meant going back to the report. I7-governed like
  `title`/`detail`: one line, ≤300 chars, may quote an exception type, never a stack trace —
  enforced on write and re-checked by `validate`. `--message` carries what the test actually
  threw alongside it — the cause is the agent's reading, the message is the evidence, and a
  reader who cannot tell them apart has to trust the reading instead of checking it.
- **`ledger.sh coverage <file> --fail-total N [--truncated true] [--dropped N]`** — how much of
  the report the table actually covers. `ingest.sh`'s ES-truncation warning and `cluster.sh`'s I6
  drop warning print to stderr only; in a GUI they vanish, and an incomplete cluster table is
  indistinguishable from a complete one. The operator picks from that table, so work never shown
  cannot be chosen and nothing said it existed.
- **`core/tests/process-parity-test.sh`** — 101 assertions that exercise `ledger.sh` against
  every name `process.json` declares, and against names it does not. A vocabulary the engine
  accepts but the contract never mentions is the same defect as the reverse.

### Fixed

- **A testbox is one thing again.** `ingest.sh` accepted `tb161` while `rerun.sh`,
  `dom-capture.sh` and `dom-on-failure.sh` rejected it with exit 77 and demanded `161`, so
  the box a driver had just ingested was refused by the very next call. All entry points now
  take either spelling (`normalize_tb` in `core/_strict.sh`).
- **The `confirm` phase sat in the wrong place.** It was second in the phase list, reading as
  the pre-cluster health-check, while `SKILL.md` uses it for the post-pick confirmation rerun.
  A driver taking that list as the phase order placed it before `pick` and then dropped every
  confirm event, forward-only phase advance making a backwards phase a no-op — so the operator
  watched "waiting for your pick" through the longest rerun in the run. The order is now
  `ingest → cluster → pick → confirm → fix → verify → report`.
- **The last grep-newline holes.** The testbox checks in `rerun.sh`, `dom-capture.sh` and
  `dom-on-failure.sh` were still `printf … | grep -qE '^[0-9]+$'`, which passes any value
  whose *first line* is numeric. They now route through `_strict.sh` like every other
  validator, completing a migration that had been described as finished.
- **`kits/*/*.tgz`** in the repo's `.gitignore` instead of a hardcoded kit directory name, so
  the guard `install-guard-test.sh` enforces covers a copy taken to work on the next version.

### Documented, not changed

- **`resolved-upstream` does not re-open**, and that is deliberate: it asserts something
  about current code rather than recording a decision about work. The parity test found the
  asymmetry, which nothing had written down. `green`, `flagged` and `deferred` do re-open.
- **`resolved-upstream` is not `green`.** A driver that renders them alike claims the kit
  proved something it never ran.

---

## 1.0.4 and earlier

No changelog was kept. What is known from diffing the published archives:

- `cluster.sh`, `ingest.sh`, `gate.sh`, `summary.sh` and `SKILL.md`'s *Presentation
  discipline* section are **byte-identical from 1.0.0 through 1.0.4**.
- The only engine change across every shipped version is `rerun.sh`.
- **1.0.2** added `ingest.sh`'s test-list mode (`--testbox` / `--tests`), growing the file
  from 101 to 169 lines. It resolves the box's *freshest* build rather than the build a
  pasted list came from, and reports `build.missing_requested` for tests the pinned build
  never ran. If the box has moved on since the list was produced, the clustering legitimately
  differs from what the operator expected — this is the likeliest explanation for a report
  that "lists differently" than it used to.

Fixes made after 1.0.4 was packed and not published in any archive until 1.0.5:
`rerun.sh` (`-Dapi.url`, void-run detection), `dom-capture.sh` / `dom-on-failure.sh`
(`cleanTest` instead of `--rerun-tasks`; "no tests ran" is no longer read as "passed"),
`ledger.sh` (terminal clusters re-openable to `selected`).
