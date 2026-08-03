# Follow-up register closure — report

Worked from `/Users/egecan.sen/sahibinden/repo/APPS/forest/.worktrees/followups`
(branch `followups`, based on merge commit `6c7af75`). Closed all four items in
`docs/superpowers/specs/2026-08-03-orphaned-provisioned-units-followups.md`
plus the tmpdir sweep.

Baseline confirmed before touching anything: `npm test` → 256 passed, 0 failed.
Final: **260 passed, 0 failed** (256 baseline + 4 new tests).

## Item 1 — `stillListed` did not reflect whether the record rewrite succeeded

**File:** `lib/actions.mjs`, `/api/worktree/remove-units` route, the `catch`
around `writeProvisionRecord` (previously only journalled a warning).

**Change:** on a caught write failure, the handler now walks every `{kind, id}`
in `gone` and:
- flips `stillListed` to `true` on the existing `refused` entry if one exists
  (the ENOENT-droppable case, which had provisionally been marked `false`
  before the write even ran);
- otherwise pushes a **new** `refused` entry (an id that had only ever
  appeared in `removed`, since the write hadn't failed yet when that array was
  built) with `stillListed: true` and a reason naming what happened.

This is the field the client (`public/app.js`) reads to decide whether the
"clean sweep" branch is safe to take (recurse into `startSession()`) versus the
"still stuck" branch (stop, tell the user, leave the picker open). Before the
fix, a record-write failure after a successful `rm` was invisible to the
client — it read `removed: [...], refused: []` and treated that as a clean
sweep.

**Reproduced before/after, exactly as the register specifies** (record file
`chmod 0444`, `.claude/kits/` left writable):

| | before fix | after fix |
| --- | --- | --- |
| `rm` | succeeds | succeeds |
| record write | throws `EACCES` | throws `EACCES` (unchanged — still best-effort) |
| response | `removed: ["kit:k"], refused: []` | `removed: ["kit:k"], refused: [{ id: "k", stillListed: true, reason: "... could not be updated ..." }]` |
| client would | take clean-sweep branch, recurse into `startSession()`, meet the guard again (the one-way loop) | take the stuck branch, tell the user, not recurse |
| record on disk | still names `k` | still names `k` (unchanged — the write really failed) |

**Test:** `lib/actions.test.mjs` — *"remove-units: a record write that throws
after a successful rm must not be reported as a clean sweep"*. Asserts the
delete really happened (file gone from disk) **and** `stillListed: true` is
reported **and** the record on disk still names the unit.

**Mutation evidence:** reverted the fix (restored the old bare-journal catch),
ran the test — it reddened with `AssertionError: 0 !== 1` on the count of
`refused` entries with `stillListed: true`. Restored the fix, reran — green.

**Side effect I judged worth fixing:** `public/app.js`'s "stuck" alert had a
hardcoded sentence — *"Their files are still on disk and still registered"* —
that was only ever true for the hardened-kit (EPERM/EACCES) case. My fix makes
`stillListed: true` reachable for a unit whose files really were deleted (rm
succeeded, record write failed), so that sentence would now be false in a
reachable state. I edited it to stop asserting a disk-state claim that isn't
always true, and to name both possible remedies (unlock-and-retry for a
hardened kit, or just retry if the record update itself failed). This is
**not covered by any test** — `app.js` has no DOM harness in this repo (see the
register's last section) — verified only by reading and `node --check
public/app.js` (syntax only). Flagging this because it's a scope decision, not
something explicitly asked for; easy to revert if you'd rather keep the
original wording and accept the (rare, double-failure) inaccuracy.

## Item 2 — two of three `repairableRecord` over-approximations were refutable

**Files:** `lib/packs.mjs` (`writesHookWiring`), `lib/actions.mjs` (doc comment
on `repairableRecord`), `docs/superpowers/specs/2026-08-03-orphaned-provisioned-units-design.md`.

**Change:** `writesHookWiring` now uses two small helpers instead of bare
`exists()`:
- `hasEntries(p)` — `readdir(p)`, `.length > 0` — for the kit's hooks
  directory. An existing-but-empty `hooks/` now answers `false` (copyTree
  would copy nothing from it).
- `isParsableJson(p)` — `readFile` + `JSON.parse` in a try/catch — for the
  kit's settings fragment. An existing-but-unparsable `settings.hooks.json`
  now answers `false` (`provisionKit`'s own `JSON.parse` on the same file
  throws and is swallowed before `mergeHooks` ever runs, so nothing gets
  written either).

Updated the doc comments in `lib/actions.mjs` and the design spec from "three
over-approximations, two unchecked" to "one over-approximation" (`install.sh`,
the genuinely undecidable case).

**Tests:** two new cases in `lib/actions.test.mjs`, added next to the existing
`repairable`-via-`launchDecision` tests (the established pattern — this
function is never unit-tested in isolation, only through the decision it
feeds, per the existing file's own convention):
- *"repairable is false for a kit with no install.sh whose hooks/ directory
  exists but is empty"*
- *"...whose settings.hooks.json is present but not valid JSON"*

**Mutation evidence:** reverted both `hasEntries`/`isParsableJson` calls back
to bare `exists()` — both new tests reddened (each with its own labeled
assertion message). Restored the fix — both green.

## Item 3 — the "Consequence" sentence held for only one kit shape

**File:** `docs/superpowers/specs/2026-08-03-orphaned-provisioned-units-design.md`,
the "Consequence, stated because it is a real limit" paragraph (now at
`:298-308` after item 2's edit shifted line numbers).

**Change:** the paragraph now says explicitly that it holds only for a kit
whose installer registers a command pointing *inside* `.claude/kits/<id>/`,
and does not hold for a convention kit (no `install.sh`) — because
`provisionKit`'s convention branch (`lib/packs.mjs:192`) copies that kit's
hook script into the shared `.claude/hooks/`, which Remove never touches
(Remove deletes only `.claude/kits/<id>/`).

**Re-verified by execution before writing the sentence** (script in the
scratchpad, not committed): provisioned a convention kit (hooks/gate.sh +
settings.hooks.json, no install.sh) into a real temp worktree, called
`/api/worktree/remove-units` on it, then `resolveSessionScope` before and
after:

```
BEFORE remove: active= 1 missing= 0
remove-units response: {"ok":true,"removed":["kit:convo-kit"],"refused":[]}
AFTER remove: active= 1 missing= 0
```

Confirms the register's own claim (`active=1 missing=0` survives Remove for a
convention kit) and that my rewritten sentence is accurate.

No code change for this item — text only.

## Item 4 — `(h.dir || h.settings)` was unpinned

**File:** `lib/packs.mjs` — no code change; the check was already correct.

**Test:** new case in `lib/actions.test.mjs` — *"repairable is false when the
pack catalog's gate set declares only schemas, no dir or settings"* — a
catalog with `hooks: { schemas: 'schemas' }` (no `dir`, no `settings`).

**Mutation evidence:** replaced `h && (h.dir || h.settings)` with `if (h)` in
`writesHookWiring` — this new test (and only this test) reddened. Restored —
green.

## Item 5 — the tmpdir sweep

**Correction to the register's own claim, found while closing it:** the
register said the leak came from `config`, `discover`, `repos`, `packs` and
`session-scope`, with `actions.test.mjs`/`packs.test.mjs` (the two files the
merged branch owned) leaking none. Measuring file-by-file
(`node --test lib/<x>.test.mjs`, `forest-*` count in `$TMPDIR` before/after
each) told a different story:

| file | measured leak |
| --- | --- |
| `lib/config.test.mjs` | 2 |
| `lib/discover.test.mjs` | 3 |
| `lib/repos.test.mjs` | **0** — already fully `try`/`finally`; misnamed as a leaker |
| `lib/session-scope.test.mjs` | 8 |
| `lib/agents.test.mjs` | **3** — a real leaker, not named in the original list |
| `lib/packs.test.mjs` | **27** — the actual biggest leaker, despite being named "leaks none" |
| `lib/actions.test.mjs` | 0 — confirmed clean |

Sum = 43, matching the register's aggregate exactly — the total was right, the
per-file attribution was wrong on three of six files.

**Fix:** added `try`/`finally` cleanup (matching `lib/actions.test.mjs` and
`lib/repos.test.mjs`'s existing idiom — no second idiom invented) to every test
in `lib/config.test.mjs`, `lib/discover.test.mjs`, `lib/session-scope.test.mjs`,
`lib/agents.test.mjs` and `lib/packs.test.mjs` that created a tmpdir without
cleaning it up. Also tightened two `discover.test.mjs` tests that only cleaned
up on the happy path (no `finally`) into `try`/`finally`, since a failing
assertion there would otherwise still leak.

**Verified, full suite, `$TMPDIR` `forest-*` count:**

- Before this work (first baseline `npm test` run I did): 1304 → 1347 (**+43
  leaked**, confirming the register's number exactly).
- After all five files fixed, full `npm test`: repeated over several runs,
  e.g. 1444 → 1444, 1446 → 1446 — **+0 leaked**, consistently, across multiple
  repeated full-suite runs.

## Suite total

`npm test`: **260 passed, 0 failed** (256 baseline + 1 test for item 1 + 2
tests for item 2 + 1 test for item 4 = 260). Ran the full suite 5+ times in a
row to check stability.

**One flake observed, unrelated to this work:** `lib/finish.test.mjs` —
*"executeFinish: conflicted merge blocks removal (guard branch unreached —
conflict returns first)"* — failed once in ~8 full runs with a real git
`index.lock` collision (`fatal: Unable to create
'.../forest-finish-.../​.git/index.lock': File exists`). I never touched
`lib/finish.mjs` or `lib/finish.test.mjs` — confirmed via `git status`. This
looks like pre-existing test-suite flakiness from concurrent real git
processes, not something this pass introduced. Ran the five files I *did*
touch 5 times in isolation with zero failures. Flagging it rather than fixing
it — it's out of scope for this register and I did not investigate root cause.

## Global constraints checked

- Plain ESM, `node:test`/`node:assert/strict` throughout — no new deps, no
  TypeScript.
- No new test reaches `launchInteractive`: grepped every test file for the
  name — the only hit is a pre-existing comment. My new tests either call
  `/api/worktree/remove-units` (never touches `launch`) or call
  `launchDecision`/`repairableRecord` directly (no route, no terminal).
- All new fixtures use `mkdtemp(join(tmpdir(), ...))`, never a real worktree,
  never `.forest/`.
- No real `chown`; the one permission-dependent test (item 1) uses `chmod
  0o444` on the record file and restores it to `0o644` in `finally` (even on
  assertion failure) so the fixture is still removable.
- No AI trailers, no bare `git stash` — I have not committed yet; will follow
  the same rule when I do.
- Did not touch `settings.json` handling anywhere.
- Every new assertion has mutation evidence: applied the mutation, confirmed
  the exact labeled assertion reddens, reverted, confirmed green again — for
  all 4 new tests (item 1 ×1, item 2 ×2, item 4 ×1).

## Things I judged differently than a literal reading might suggest

1. **The tmpdir file list correction** (above) — I could have silently fixed
   only the files literally named in the register and left `packs.test.mjs`
   alone as "already clean" per the old claim, or silently "fixed" `repos`
   which needed no fix. Instead I measured everything and reported the actual
   breakdown, since shipping a register that still misattributes the leak
   after claiming to have closed the item would be exactly the kind of
   uncaught false sentence this task asked me to watch for.
2. **The `app.js` text edit** (item 1's side effect) — explained above; kept
   deliberately minimal, called out as unverified-by-test, easy to revert.
3. Left the two `discover.test.mjs` happy-path-only cleanups (locked worktree,
   detached worktree tests) upgraded to `try`/`finally` even though they
   weren't currently leaking (assertions there pass on the happy path) —
   cheap robustness win in a file I was already editing, using the same idiom.

## Concerns

- The pre-existing `finish.test.mjs` git-lock flake (see above) — not fixed,
  not investigated beyond confirming it's unrelated to my changes and that I
  never touched that file.
- The `app.js` wording change has zero automated coverage, same as the rest of
  that file. If you'd rather not touch client copy in this pass, it's a
  one-string revert (`public/app.js`, the "stuck" alert's closing sentence).
