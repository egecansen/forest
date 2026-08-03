# Orphaned provisioned units — design spec

**Date:** 2026-08-03
**Repo:** `APPS/forest`
**Status:** approved by Egecan, pending implementation

## Problem

A worktree can run a kit that forest no longer manages, frozen at whatever
version it had when it was last selected, with nothing to notice.

### The incident

`.forest/wt/web-test/tech-WEBT-229553`, 2026-08-03. The session emitted
`PreToolUse:Bash hook error … flaky-kit-self-protection-gate.sh: No such file
or directory` on every Bash call.

The worktree's flaky-triage kit was from 2026-07-30 while `SKLS/hektor` had
moved to 2026-08-02: no `_wiring_repair.sh`, no delivery gate, no `.harness`
record. Its provision record, rewritten at 07:16:38 — the same second the
session started — read `"kits": []`.

### The mechanism

`provisionPack` (`lib/packs.mjs:210`) is **additive**. It copies what the
selection names and leaves everything else in place.

`/api/launch` (`lib/actions.mjs:518-590`) provisions from the selections in the
**request body** — whatever the UI has checked at that moment — then overwrites
the stored record with them (`:556`).

So a unit that stays selected is re-provisioned on every launch — which for a
kit that ships `install.sh` means its own installer is re-run from source
(`lib/packs.mjs:176-191`), and that is what can bring a kit current. It is not
a general refresh: `copyTree` (`lib/packs.mjs:96-99`) skips any destination file
whose content differs and records a conflict, so a plain skill and the copy
under `.claude/kits/<id>/` keep whatever is already on disk. (Deliberate — it
protects hand-edited files. Corrected 2026-08-03 after the branch review, where
this paragraph read "cannot go stale".)

A unit that stops being selected is left on disk at its last version, still
registered, still executing — and because the record is overwritten, it
disappears from the record entirely. `/api/worktree/repair` (`:325-336`)
re-provisions from `rec.selections`, so it never touches it either. The unit is
orphaned: installed, running, and unmanaged.

```
2026-07-30  launch  kits:["flaky-triage-kit"]  → installed, registered
2026-08-03  launch  kits:[]                    → left at the 07-30 version,
                                                 still registered, now invisible
                                                 to both the record and repair
```

### Why the existing guard does not catch it

The launch guard from the 2026-08-01 spec (`launchDecision`,
`lib/actions.mjs:86-99`) asks `session-scope.mjs:85` for `missing`, which is a
`stat()` on each registered hook command: present or absent. An orphaned unit's
files are **present**. They are merely old, and out of forest's management.

Presence stands in for "this worktree is correctly provisioned". The property is
"what is installed matches what was selected." The two diverge the moment
something is deselected.

### Scale

Nine worktrees carry provision records. Two (`tech-WEBT-229553`,
`tech-WEBT-250404`) select no kits while the kit's files are present. The other
seven still select it, and are therefore refreshed on every launch.

## Decision

Settled 2026-08-03: **warn at launch and offer repair.** Forest does not delete
a unit on its own — the 2026-08-01 rule that forest never mutates a worktree
without a yes stands, and removal is a larger mutation than the addition that
rule was written for.

Reconcile-on-provision (delete what is no longer selected) was considered and
rejected for this round: it would also sweep away anything installed by hand,
and it needs a confirmation flow of its own.

## Design

### 1. The record says what was written, not only what was asked for

`writeProvisionRecord(worktreePath, selections)` (`lib/packs.mjs:308`) gains a
third parameter:

```js
export async function writeProvisionRecord(worktreePath, selections, inventory = null, at = null)
```

(`at` is the fourth parameter, added for the removal path — see §5. It defaults
to now, which is right for a provision: that is when these units were written.)

written as:

```json
{
  "at": "2026-08-03T07:16:38.097Z",
  "selections": [ … ],
  "inventory": { "kits": ["flaky-triage-kit"], "skills": ["hektor-verify", …] }
}
```

`runSelections` (`lib/actions.mjs:173-191`) already returns exactly this — its
`out.kits` and `out.skills` are what provisioning actually produced. The
inventory is `{ kits: provisioned.kits, skills: provisioned.skills }`, no new
bookkeeping.

`kitSkills` is deliberately excluded. Those skill directories are installed by a
kit's own installer and belong to the kit; they are managed by updating or
removing the kit, not on their own.

`readProvisionRecord` (`:317`) is unchanged — it returns whatever the file
holds, and a record without `inventory` reads as `undefined`.

### 2. Orphan detection, before provisioning overwrites the record

A new pure function beside `launchDecision`:

```js
export function orphanedUnits(previousRecord, selections)
```

It returns `[{ kind: 'kit' | 'skill', id, since }]` for every id in
`previousRecord.inventory` that no incoming selection names. `since` is
`previousRecord.at`. A record with no `inventory` yields `[]`.

Keeping it pure and separate from `launchDecision` matters because the two
answer different questions from different inputs — `launchDecision` reads the
worktree's current disk state, `orphanedUnits` compares two records. Folding
them together would mean one function taking both a path and a selection and
deciding which of two unrelated conditions to report.

### 3. Ordering — the part that silently breaks

In `/api/launch`, the previous record must be read **before** `runSelections`
runs and `writeProvisionRecord` overwrites it:

```js
const previous = await readProvisionRecord(path).catch(() => null);
const orphans = orphanedUnits(previous, sel);
// … provision, write the new record …
```

Read after, and the comparison is the new selection against itself: always
empty, always green, and the guard is silently inert. This is the failure this
section exists to prevent, and it must have its own test.

### 4. The blocked payload

`/api/launch` returns the existing shape with a second reason:

```json
{ "ok": false,
  "blocked": "orphaned-units",
  "orphaned": [{ "kind": "kit", "id": "flaky-triage-kit", "since": "2026-07-30T…" }],
  "repairable": false }
```

(This example read `"repairable": true` until 2026-08-03 — four lines above the
prose saying it is a constant `false`. Corrected after the branch review: a
reader copies the JSON, not the paragraph.)

`orphaned-units` takes priority. This section originally gave it to
`missing-hooks` — a registered-but-absent gate is a live hole, an orphan is a
stale unit that still runs — and that ordering turned out to be unimplementable:
the orphan check must run *before* provisioning (§3), and a missing gate cannot
be evaluated until after it, because provisioning may be what installs the gate.
So if both hold, the orphan is reported, the user resolves it, and
`missing-hooks` is met on the next launch.

`repairable` does **not** keep its old meaning ("a usable provision record
exists"). It answers whether `/api/worktree/repair` can fix *this* block:

- On `missing-hooks`: repair replays `rec.selections` through `provisionPack`
  and does nothing else, so it can only move `missing` if replaying those
  selections writes some **hook wiring** — a script under `.claude/hooks/`
  (what a registration points at) or a settings fragment merged into
  `.claude/settings.local.json` (the registration itself). Those two are what
  forest writes *by convention*; a kit's own `install.sh` may write either, and
  forest cannot see which, which is what makes that one case a "maybe" below.

  `writesHookWiring` (`lib/packs.mjs:271`) answers that by asking the pack
  source with the same calls provisioning makes, in the same order:
  `exists(packDir/kits/<id>)` (`:224` — a kit the pack no longer ships is
  skipped outright, so replaying it writes nothing at all), then
  `exists(kitDir/install.sh)` (`:177`), then the hooks-dir and
  settings-fragment conventions, then the catalog's own gate set for
  `hooks: true`.

  This was originally written as a record-**shape** rule — "the record still
  names a kit, or `hooks: true`" — and **that was wrong, corrected 2026-08-03
  after the branch review.** Shape never asks whether the named selection can
  write anything, and two reachable states falsified it: a record naming a kit
  that ships only `kit.json`, and a record naming a kit the pack no longer
  ships. Both got `repairable: true` with `missing` frozen forever. In the
  second, a single `exists()` refutes the claim, so asserting it was not
  conservatism about an unknown — it was asserting an already-decided
  possibility.

  `true` remains an over-approximation in exactly one place, and it is
  genuinely undecidable: a kit that ships `install.sh` owns its own wiring and
  forest cannot predict which files that installer touches. Two other cases
  read like over-approximations at first — a kit whose `hooks/` directory
  exists but is empty, and a kit whose `settings.hooks.json` is present but not
  valid JSON — but both are refutable by a content check, and `writesHookWiring`
  performs both (`readdir` for the first, `JSON.parse` for the second; added
  2026-08-03 closing a follow-up from this branch's own review). Everything
  else is refutable, and refuted where it is false. A record naming only plain
  skills is still `false` — a skill is copied into `.claude/skills/<id>/` and
  touches no settings file and no hook script.

  Without a readable `packsDir` the answer is `false`, and correctly so: a
  replay through that same `packsDir` would find nothing to provision either.
- On `orphaned-units`: a constant `false`. Repair cannot change the incoming
  selection, which is the half of the comparison that makes a unit an orphan,
  so a repair run leaves the block exactly where it stands however full the
  record is. `repairableRecord` is not consulted; the question it answers is a
  different one.

### 5. Client

`public/app.js:614` already branches on `r.blocked`. It gains the
`orphaned-units` case (`:679`), listing each orphan as `kind: id (since date)`
and offering three actions:

- **Update** — add the orphans back to the selection and re-launch. That clears
  the guard and puts them back under forest's management; for a kit that ships
  `install.sh` it also re-runs that installer, which is what can bring the kit
  current. It is not a refresh of everything: a plain skill and the copy under
  `.claude/kits/<id>/` are left at whatever is on disk (see the mechanism
  above), and the UI says so rather than implying a version bump.
- **Remove** — POST the orphan list to be deleted, then re-launch — but only
  on a clean sweep (see below).
- **Launch anyway** — the existing `force: true` path (`:732`), unchanged. The
  response's `scope.missing` is displayed: a forced launch that proceeds with a
  registered-but-absent gate has to say so.

Remove needs a route; it is the only new server surface beyond the guard.
It deletes `.claude/kits/<id>/` for a kit and `.claude/skills/<id>/` for a
skill. It does not touch registrations: a kit's own installer owns its wiring,
and forest guessing at jq surgery on `settings.json` is the class of mistake
`provisionKit`'s comment at `lib/packs.mjs:155-169` already records.

There is no uninstall path to call — neither the flaky-triage kit nor any other
ships one, and forest's manifest has no concept of it. Remove is a directory
deletion and nothing more. Two consequences follow and both must be reported
rather than papered over:

- A **hardened** kit's files are root-owned, so the deletion fails with
  `EPERM`. The route reports that in the kit's own vocabulary — the install
  refusal at `lib/packs.mjs:183-186` already has the wording to match — and
  changes nothing. Unlocking is the user's decision and needs their password.
  Its id **stays in the record**: the files really are still there, still
  registered, still executing, so the guard reporting it again is correct.
- A kit that installed skill directories of its own leaves them behind, since
  `kitSkills` is outside the inventory (§1). They are inert without the kit's
  engine, and removing them would need the ownership map forest does not keep.
  The confirmation says this before the user accepts an irreversible action.

**The route also rewrites the provision record**, dropping the removed ids from
`inventory` and from `selections`. Both halves, and for different reasons:
`inventory` is what the orphan guard compares against, so leaving an id there
re-blocks the next launch on a unit that is no longer on disk — with Remove as
the only offered remedy and nothing left to remove. `selections` is what repair
replays, so leaving an id there means the next repair reinstalls exactly what
the user asked to delete.

**Which ids get dropped is decided by the refusal, not by the deletion.** A
unit reaching the rewrite only on a successful `rm` left the one-way door open
for every refusal — the id stayed in `inventory`, the guard re-blocked on it,
and Remove could never clear it. The two kinds are opposites and the route
treats them as such (corrected 2026-08-03 after the branch review):

- **`ENOENT`** — the unit is not on disk. Nothing was removed because there was
  nothing there; the record is simply wrong to list it. Dropped as if removed.
- **`EPERM`/`EACCES`** — the files really are still there. **Kept**, per the
  hardened-kit bullet above.
- anything else — kept. Forest does not know what is on disk, and the guard is
  the conservative place to be wrong.

Each refusal carries `stillListed` — "forest did not drop this id from the
record" — so the client can say which of these happened. It says "this guard is
clear" only on a **clean sweep**, and when something is still listed it names it,
says why, and does **not** re-launch: recursing was only ever honest because the
guard was clear, so when it is not, re-opening the same dialog on the user's
behalf is the loop rather than the remedy. The picker stays open, so "Launch
anyway" is still one deliberate click away.

The record is rewritten through the same `writeProvisionRecord` every other
caller uses; it takes an optional `at`, and the route passes the record's own
through — a removal does not re-provision what survives it, and stamping a fresh
one made a surviving orphan's `since` read as the removal date, i.e. newer and
so safer than it is, in the dialog that gates an irreversible action.

**Consequence, stated because it is a real limit — and it holds for only one of
the two kit shapes:** for a kit whose installer registers a command pointing
*inside* `.claude/kits/<id>/`, removing its files without removing its
registration produces exactly the `missing-hooks` state the existing guard
catches on the next launch. **It does not hold for a convention kit** — one
with no `install.sh` — because `provisionKit`'s convention branch copies that
kit's hook script into the shared `.claude/hooks/` (`lib/packs.mjs:192`), never
into `.claude/kits/<id>/`; Remove deletes only the latter, so the script and the
registration pointing at it both survive. Executed: after Remove, session scope
reports `active=1 missing=0` and the relaunch launches cleanly — not the
`missing-hooks` state this paragraph describes.

This section originally called that "the intended handoff — the next launch
blocks on it and offers the repair that rewrites the registration." **That was
wrong, and was corrected 2026-08-03 after the branch review.** Repair
re-provisions from `rec.selections`, which no longer names the removed unit, so
the installer that owns the registration never runs again and `missing` never
moves; the offer was a loop, not a handoff. The honest remedy is to re-select
the unit and launch — that re-runs its own installer, which rewrites the
registration — or to edit `.claude/settings.json` by hand.

**The correction itself then shipped a second false sentence**, caught in the
final review round and fixed here: it claimed "`repairable` is `false` in that
state (§4) so no Repair is offered." It is not, and it contradicted §4's own
rule four paragraphs above it. `repairable` says nothing about *which* unit
wrote the dangling registration — only whether replaying whatever the record
*still* names could write any hook wiring at all. After a Remove, the record
usually still names something, and if any of it is a kit the pack still ships
that has an `install.sh`, `repairable` is `true` and Repair *is* offered. That
is not a false promise — such a repair genuinely might rewrite the
registration, because forest cannot know what that installer writes — but it
is not a guarantee either, and the spec must not describe it as one.

So the true statement is: **whatever `repairable` says, the UI always names the
remedy that works.** Repair is offered when it *could* help and says "may", not
"will"; it is refused, with the reason, when it provably cannot. The remedy
paragraph is not gated on the flag, because a user told only "Repair before
launching?" when repair cannot help has been actively misdirected — which is
exactly what the gating produced for a record naming a kit the pack no longer
ships.

### 6. Journal

Both outcomes get a line, matching the existing `launch blocked: …` entry at
`lib/actions.mjs:574`:

```
launch blocked: 1 provisioned unit(s) no longer selected (flaky-triage-kit)
```

## What this does not do

- **It cannot repair a running session.** Claude Code loads hook configuration
  at session start; nothing forest does reaches a live session. That limit is
  recorded in the 2026-08-01 spec and is unchanged here. This guard stops a
  *new* session from starting into the state.
- **The first launch after this ships cannot detect orphans.** No existing
  record carries an `inventory`; each gains one on its next launch, and
  detection begins from the launch after that. A one-time blind spot that heals
  itself. Inferring an inventory from disk was rejected: `.claude/kits/<id>/` is
  absent in the very worktree that failed, so the inference would be wrong
  exactly where it is needed.
- **It does not cover the `hooks` flag.** `hooks: true|false` is one boolean
  over the pack's gate directory, not a set of units, so it has no orphan shape.

## Testing

`lib/actions.test.mjs`, alongside the `missing-hooks` cases at `:166` onward.

1. `orphanedUnits` returns the deselected kit when the previous record's
   inventory names it and the new selection does not.
2. `orphanedUnits` returns `[]` for a record with no `inventory` — the migration
   path, asserted rather than assumed.
3. `orphanedUnits` returns `[]` when the selection still names the unit.
4. `/api/launch` returns `blocked: 'orphaned-units'` with the orphan listed, and
   does **not** open a terminal.
5. `force: true` launches despite orphans.
6. `orphaned-units` wins when both conditions hold (see §4 — this read
   `missing-hooks` until the ordering turned out to be unimplementable).
7. **Ordering:** the route detects an orphan whose only evidence was in the
   record it is about to overwrite. This test fails if the read moves after
   `writeProvisionRecord` — the specific regression §3 describes.
8. `writeProvisionRecord` persists the inventory, and a record written without
   one still reads back cleanly.
9. Remove deletes a kit's directory and reports the `EPERM` refusal without
   deleting anything when the tree is root-owned. The root-owned case is driven
   with a `chmod`-based fixture under `mktemp -d`, never a real `chown` — a bare
   `chown root` needs a password nobody can answer in a test run.
10. **Convergence, at the route level:** block → remove → relaunch → force →
    relaunch. The relaunch after Remove must not report `orphaned-units` again,
    and no step may return `repairable: true` for a state repair cannot fix.
    Added after the branch review, whose absence is what let a one-way Remove
    reach a final review.
11. Remove drops the id from **both** `inventory` and `selections`, leaves a
    record that never had an inventory without one, and preserves the record's
    `at` so a surviving unit's `since` does not read as the removal date.
12. A refusal is worded for a human: a unit that is not on disk reports
    "already gone", never a raw `ENOENT … lstat '/var/…'`.
13. **`repairable` against a real pack** (§4). Every case needs a pack on disk,
    because the record looks identical in the `true` and `false` cases and a
    shape-based test could not tell them apart at all:
    - a kit the pack still ships, with `install.sh` → `true`;
    - a kit with no installer but a hooks dir, or a settings fragment → `true`;
    - a catalog declaring a gate set, with `hooks: true` → `true`;
    - a **surviving kit that ships only `kit.json`** → `false` (the case that
      falsified the old shape rule);
    - a kit the pack **no longer ships** → `false` (one `exists()` settles it);
    - only plain skills, and a catalog with no gate set → `false`.
14. **The record consequence of each refusal kind** (§5), each driven to the
    relaunch that proves it: an `ENOENT` refusal drops the id and the next
    launch no longer reports `orphaned-units`; an `EPERM` refusal keeps it and
    the next launch correctly reports it again. Both assert `stillListed`,
    which is what the client branches on.

Each new assertion is proven by mutation: it must redden when the behaviour it
names is reverted, and the ordering test must redden when the read moves.
Fixtures live under `mktemp -d` and are removed in a `finally` — including the
`chmod`-hardened one, whose restore belongs in the `finally` too or a failing
assertion above it leaves a directory the sweep cannot remove.

## Files

- `lib/packs.mjs` — `writeProvisionRecord` gains the inventory parameter and an
  optional `at`; `writesHookWiring` answers §4's question from the pack source
- `lib/actions.mjs` — `orphanedUnits`, the read-before-provision ordering, the
  blocked payload, the journal line, the remove route and its two refusal kinds
- `public/app.js` — the `orphaned-units` branch and its three actions
- `lib/actions.test.mjs`, `lib/packs.test.mjs` — the cases above
