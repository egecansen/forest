# Orphaned provisioned units — follow-up register

Four items left open when `orphaned-units` merged (2026-08-03, 21 commits,
suite 205/0). Each was found by review, verified by execution, adjudicated,
and parked with a reason. None is a correctness regression on the paths this
branch owns — that is why they are here and not in the branch.

They are recorded because the branch's execution ledger lived in a git-ignored
workspace that goes away with the worktree.

## 1. `stillListed` does not reflect whether the record rewrite succeeded

`lib/actions.mjs:407-423`. **Track this one; it is the one that can bite.**

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

One-line fix: that `catch` should clear `gone` (or flip `stillListed`) rather
than only journalling.

## 2. Two of the three over-approximations in `repairableRecord` are refutable

`lib/actions.mjs:62-65`, `lib/packs.mjs` (`writesHookWiring`).

`repairable` answers "can repair actually fix this" by asking the pack source
whether the recorded selection can write any hook wiring. It over-approximates
in three places. Only one is genuinely undecidable — a kit shipping
`install.sh`, whose installer forest cannot predict.

The other two are decidable and simply not checked:

- a kit whose `hooks/` directory **exists but is empty** answers `true`, and
  repair writes nothing;
- a kit whose `settings.hooks.json` is **present but not valid JSON** answers
  `true`, and `provisionKit` swallows the parse failure at `lib/packs.mjs:202-204`.

A `readdir` and a `JSON.parse` settle both. The comment and the spec now say
this plainly rather than claiming a single over-approximation, so the register
entry is the missing content checks, not the wording.

Cost today is one extra dialog, not a dead end — the remedy text is no longer
gated on `repairable`, so a user offered a Repair that does nothing still
learns the remedy that works.

## 3. `spec:292-294`'s "Consequence" holds for only one of the two kit shapes

Stated unconditionally, and false for a **convention** kit — one with no
`install.sh`, whose hook script is copied to `.claude/hooks/` and therefore
survives a Remove that only deletes `.claude/kits/<id>/`. Executed: after
Remove, `active=1 missing=0` and the relaunch launches cleanly, so it does not
produce "exactly the `missing-hooks` state".

It holds only for a kit whose installer registers a command pointing inside
`.claude/kits/<id>/`. Predates this branch; sits in a paragraph the branch
rewrote, so it is recorded here rather than silently left.

## 4. `lib/packs.mjs:292`'s `(h.dir || h.settings)` is unpinned

Replacing it with `if (h)` leaves the suite green, because no fixture ships a
catalog declaring only `hooks: { schemas: … }`. The code answers `false` for
that state correctly — verified by execution — but nothing guards it.

## Not in this register, but worth a sweep

The suite leaks **43 tmpdirs** per run from `config`, `discover`, `repos`,
`packs` and `session-scope` — five files this branch did not touch. At the time
of writing `$TMPDIR` held 11,768 accumulated `forest-*` directories. The two
files this branch owns (`lib/actions.test.mjs`, `lib/packs.test.mjs`) leak none.

## What has no automated coverage

`public/app.js` has no DOM test and this repo has no browser harness. The
client's branch selection was verified by evaluating the expressions extracted
from the file against real route payloads, and the full dialog flows were driven
once through a browser during development — but that harness was never
committed, so **no client behaviour is pinned by anything repeatable**. A change
to `app.js` can break any of it with no automated signal.
