# Orphaned provisioned units — follow-up register

Four items left open when `orphaned-units` merged (2026-08-03, 21 commits,
suite 205/0). Each was found by review, verified by execution, adjudicated,
and parked with a reason. None is a correctness regression on the paths this
branch owns — that is why they are here and not in the branch.

They are recorded because the branch's execution ledger lived in a git-ignored
workspace that goes away with the worktree.

**Status (2026-08-03, `followups` branch): all four items closed, plus the
tmpdir sweep. Suite 260/0 (256 baseline + 4 new tests). Details per item below.**

## 1. `stillListed` does not reflect whether the record rewrite succeeded — CLOSED

`lib/actions.mjs`, the `remove-units` route (catch block around the record
rewrite). **Track this one; it is the one that can bite.**

When `remove-units` deletes a unit it rewrites the provision record to drop the
id. That write is best-effort: if it throws, the failure is journalled and
nothing else happens. But `stillListed` — the field the client uses to decide
whether the guard is now clear — is computed from whether the `rm` succeeded,
not from whether the record was actually updated.

Reproduced with the record file at `0444` and `.claude/kits/` writable: `rm`
succeeds, the write throws `EACCES`, the route still returns
`removed: [kit-a], refused: []`, so the client takes the clean-sweep branch,
alerts *"the record no longer lists them, so this guard is clear"*, and
recurses into `startSession()` — which blocks on the same unit immediately.

That is the one-way-door loop this branch removed, surviving behind a rarer
trigger. Not a dead end: "Launch anyway" is reachable from the recursion.

**Fix applied:** the `catch` around the record write now, in addition to
journalling, walks every id in `gone` and flips it to `stillListed: true` —
updating the existing `refused` entry for an id that was provisionally marked
droppable (the ENOENT case), and adding a new `refused` entry (with its own
reason) for an id that had been reported only in `removed` (a clean `rm` with
no record consequence yet, since the write hadn't run when that entry was
built). The client's clean-sweep branch reads `refused[].stillListed`, so this
is what stops it firing on a record write that never landed.

**Test:** `lib/actions.test.mjs` — *"remove-units: a record write that throws
after a successful rm must not be reported as a clean sweep"*. Reproduces the
exact repro (record file `chmod 0444`, kit dir writable), asserts the delete
really happened (`removed`, and the kit dir is gone from disk) AND that the
response reports `stillListed: true` for it AND that the record on disk still
names the unit. **Mutation evidence:** reverting the fix (leaving the old
bare-journal catch) reddens this test — `0 !== 1` on the `stillListed` count.

## 2. Two of the three over-approximations in `repairableRecord` are refutable — CLOSED

`lib/actions.mjs` (`repairableRecord`'s doc comment), `lib/packs.mjs`
(`writesHookWiring`).

`repairable` answers "can repair actually fix this" by asking the pack source
whether the recorded selection can write any hook wiring. It over-approximated
in three places. Only one is genuinely undecidable — a kit shipping
`install.sh`, whose installer forest cannot predict.

The other two were decidable and simply not checked:

- a kit whose `hooks/` directory **exists but is empty** answered `true`, and
  repair writes nothing;
- a kit whose `settings.hooks.json` is **present but not valid JSON** answered
  `true`, and `provisionKit` swallows the parse failure.

**Fix applied:** `writesHookWiring` now calls a `hasEntries` helper (`readdir`,
non-empty) instead of `exists` for the hooks directory, and an `isParsableJson`
helper (`readFile` + `JSON.parse` in a try/catch) instead of `exists` for the
settings fragment. Both helpers and the call sites live in `lib/packs.mjs`
right above `writesHookWiring`. The doc comments in both `lib/actions.mjs` and
`docs/superpowers/specs/2026-08-03-orphaned-provisioned-units-design.md` are
updated to say **one** remaining over-approximation (`install.sh`), not three.

**Tests:** two new cases in `lib/actions.test.mjs`, both via `launchDecision`/
`repairableRecord` (the existing test pattern for this function — it is never
unit-tested directly, only through the decision it feeds):
*"repairable is false for a kit with no install.sh whose hooks/ directory
exists but is empty"* and *"...whose settings.hooks.json is present but not
valid JSON"*. **Mutation evidence:** reverting both checks back to bare
`exists()` reddens both tests.

Cost before the fix was one extra dialog, not a dead end — the remedy text was
never gated on `repairable`, so a user offered a Repair that does nothing still
learned the remedy that works. That property is unchanged; this closes the
over-approximation itself, not a user-facing regression.

## 3. `spec:298-308`'s "Consequence" holds for only one of the two kit shapes — CLOSED

Stated unconditionally, and false for a **convention** kit — one with no
`install.sh`, whose hook script is copied to `.claude/hooks/` (`provisionKit`'s
convention branch, `lib/packs.mjs:192`) and therefore survives a Remove that
only deletes `.claude/kits/<id>/`. Executed: after Remove, `active=1 missing=0`
and the relaunch launches cleanly, so it does not produce "exactly the
`missing-hooks` state".

It holds only for a kit whose installer registers a command pointing inside
`.claude/kits/<id>/`. Predates this branch; sat in a paragraph the branch
rewrote, so it was recorded here rather than silently left.

**Fix applied:** the "Consequence" paragraph in
`docs/superpowers/specs/2026-08-03-orphaned-provisioned-units-design.md` now
states which kit shape it holds for (installer-registered, pointing inside
`.claude/kits/<id>/`) and explicitly says it does not hold for a convention
kit, naming the `lib/packs.mjs:192` copy destination and the executed
`active=1 missing=0` result as the counter-evidence. Re-verified by execution
during this pass (see the followups report) before writing the sentence.

## 4. `lib/packs.mjs`'s `(h.dir || h.settings)` is unpinned — CLOSED

Replacing it with `if (h)` left the suite green, because no fixture shipped a
catalog declaring only `hooks: { schemas: … }`. The code answered `false` for
that state correctly — verified by execution — but nothing guarded it.

**Fix applied:** no code change (the check was already correct) — added the
missing fixture. **Test:** `lib/actions.test.mjs` — *"repairable is false when
the pack catalog's gate set declares only schemas, no dir or settings"*, a
catalog with `hooks: { schemas: 'schemas' }` and no `dir`/`settings`.
**Mutation evidence:** replacing `h && (h.dir || h.settings)` with `if (h)`
reddens this test and only this test.

## Not in this register, but worth a sweep — CLOSED

**Correction to this section's own claim, found while closing it:** the
original text said the leak came from `config`, `discover`, `repos`, `packs`
and `session-scope`, and that the two files this branch owned
(`lib/actions.test.mjs`, `lib/packs.test.mjs`) leaked none. Measured file-by-file
(`node --test lib/<x>.test.mjs`, counting `forest-*` dirs in `$TMPDIR` before
and after each), the actual breakdown was:

| file | leaked (measured) |
| --- | --- |
| `lib/config.test.mjs` | 2 |
| `lib/discover.test.mjs` | 3 |
| `lib/repos.test.mjs` | **0** — already fully `try`/`finally`, not a leaker |
| `lib/session-scope.test.mjs` | 8 |
| `lib/agents.test.mjs` | **3** — leaked, not named in the original list |
| `lib/packs.test.mjs` | **27** — the biggest leaker, despite being named as clean |
| `lib/actions.test.mjs` | 0 (confirmed) |

Total: 43, matching the original aggregate count exactly — the total was
right, the per-file attribution was not: `repos` was misnamed as a leaker,
`agents` was omitted, and `packs.test.mjs` (most of its tests predate this
branch and never had `try`/`finally`) was misnamed as clean.

**Fix applied:** added `try`/`finally` cleanup, matching `lib/actions.test.mjs`
and `lib/repos.test.mjs`'s existing idiom, to every test in
`lib/config.test.mjs`, `lib/discover.test.mjs`, `lib/session-scope.test.mjs`,
`lib/agents.test.mjs` and `lib/packs.test.mjs` that creates a tmpdir without
cleaning it up. No second idiom introduced.

**Verified:** `forest-*` count in `$TMPDIR` before a full `npm test` run and
after are now equal (see the followups report for the exact numbers from this
pass) — the suite no longer accumulates temp directories.

## What has no automated coverage

`public/app.js` has no DOM test and this repo has no browser harness. The
client's branch selection was verified by evaluating the expressions extracted
from the file against real route payloads, and the full dialog flows were driven
once through a browser during development — but that harness was never
committed, so **no client behaviour is pinned by anything repeatable**. A change
to `app.js` can break any of it with no automated signal.

Closing item 1 touched this file once, unavoidably: `stillListed: true` can now
occur for a unit whose files really were deleted (the record write failed after
a successful `rm`), not only for the hardened-kit case the "still on disk"
sentence in the stuck-units alert was written for. That sentence was edited to
stop asserting a disk-state claim that is no longer always true. Verified only
by reading and `node --check`, same as everything else in this section — not by
running it.
