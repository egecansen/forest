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

`provisionPack` (`lib/packs.mjs:206`) is **additive**. It copies what the
selection names and leaves everything else in place.

`/api/launch` (`lib/actions.mjs:303-335`) provisions from the selections in the
**request body** — whatever the UI has checked at that moment — then overwrites
the stored record with them (`:310`).

So a unit that stays selected is re-provisioned on every launch — which for a
kit that ships `install.sh` means its own installer is re-run from source
(`lib/packs.mjs:176-190`), and that is what can bring a kit current. It is not
a general refresh: `copyTree` (`lib/packs.mjs:96-99`) skips any destination file
whose content differs and records a conflict, so a plain skill and the copy
under `.claude/kits/<id>/` keep whatever is already on disk. (Deliberate — it
protects hand-edited files. Corrected 2026-08-03 after the branch review, where
this paragraph read "cannot go stale".)

A unit that stops being selected is left on disk at its last version, still
registered, still executing — and because the record is overwritten, it
disappears from the record entirely. `/api/worktree/repair` (`:199-205`)
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
`lib/actions.mjs:31-44`) asks `session-scope.mjs:85` for `missing`, which is a
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

`writeProvisionRecord(worktreePath, selections)` (`lib/packs.mjs:243`) gains a
third parameter:

```js
export async function writeProvisionRecord(worktreePath, selections, inventory = null)
```

written as:

```json
{
  "at": "2026-08-03T07:16:38.097Z",
  "selections": [ … ],
  "inventory": { "kits": ["flaky-triage-kit"], "skills": ["hektor-verify", …] }
}
```

`runSelections` (`lib/actions.mjs:51-69`) already returns exactly this — its
`out.kits` and `out.skills` are what provisioning actually produced. The
inventory is `{ kits: provisioned.kits, skills: provisioned.skills }`, no new
bookkeeping.

`kitSkills` is deliberately excluded. Those skill directories are installed by a
kit's own installer and belong to the kit; they are managed by updating or
removing the kit, not on their own.

`readProvisionRecord` (`:250`) is unchanged — it returns whatever the file
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
  "repairable": true }
```

`orphaned-units` takes priority. This section originally gave it to
`missing-hooks` — a registered-but-absent gate is a live hole, an orphan is a
stale unit that still runs — and that ordering turned out to be unimplementable:
the orphan check must run *before* provisioning (§3), and a missing gate cannot
be evaluated until after it, because provisioning may be what installs the gate.
So if both hold, the orphan is reported, the user resolves it, and
`missing-hooks` is met on the next launch.

`repairable` does **not** keep its old meaning ("a usable provision record
exists"). It answers whether `/api/worktree/repair` can fix *this* block:

- On `missing-hooks`: repair replays `rec.selections`, so it can rewrite a
  registration only when the record still names a kit (whose `install.sh` owns
  its wiring) or the pack's gate set (`hooks: true`). A record naming only plain
  skills provably cannot — a skill is copied into `.claude/skills/<id>/` and
  touches no settings file and no hook script.
- On `orphaned-units`: a constant `false`. Repair cannot change the incoming
  selection, which is the half of the comparison that makes a unit an orphan,
  so a repair run leaves the block exactly where it stands however full the
  record is.

### 5. Client

`public/app.js:583` already branches on `r.blocked`. It gains the
`orphaned-units` case, listing each orphan as `kind: id (since date)` and
offering three actions:

- **Update** — add the orphans back to the selection and re-launch. That clears
  the guard and puts them back under forest's management; for a kit that ships
  `install.sh` it also re-runs that installer, which is what can bring the kit
  current. It is not a refresh of everything: a plain skill and the copy under
  `.claude/kits/<id>/` are left at whatever is on disk (see the mechanism
  above), and the UI says so rather than implying a version bump.
- **Remove** — POST the orphan list to be deleted, then re-launch.
- **Launch anyway** — the existing `force: true` path (`:623`), unchanged. The
  response's `scope.missing` is displayed: a forced launch that proceeds with a
  registered-but-absent gate has to say so.

Remove needs a route; it is the only new server surface beyond the guard.
It deletes `.claude/kits/<id>/` for a kit and `.claude/skills/<id>/` for a
skill. It does not touch registrations: a kit's own installer owns its wiring,
and forest guessing at jq surgery on `settings.json` is the class of mistake
`provisionKit`'s comment at `lib/packs.mjs:154-165` already records.

There is no uninstall path to call — neither the flaky-triage kit nor any other
ships one, and forest's manifest has no concept of it. Remove is a directory
deletion and nothing more. Two consequences follow and both must be reported
rather than papered over:

- A **hardened** kit's files are root-owned, so the deletion fails with
  `EPERM`. The route reports that in the kit's own vocabulary — the install
  refusal at `lib/packs.mjs:179-182` already has the wording to match — and
  changes nothing. Unlocking is the user's decision and needs their password.
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
the user asked to delete. The record is rewritten through the same
`writeProvisionRecord` every other caller uses; it stamps a fresh `at`, so the
surviving units' `since` reads as the removal time rather than their original
provision.

**Consequence, stated because it is a real limit:** removing a kit's files
without removing its registration produces exactly the `missing-hooks` state the
existing guard catches on the next launch.

This section originally called that "the intended handoff — the next launch
blocks on it and offers the repair that rewrites the registration." **That was
wrong, and was corrected 2026-08-03 after the branch review.** Repair
re-provisions from `rec.selections`, which no longer names the removed unit, so
the installer that owns the registration never runs again and `missing` never
moves; the offer was a loop, not a handoff. The honest remedy is to re-select
the unit and launch — that re-runs its own installer, which rewrites the
registration — or to edit `.claude/settings.json` by hand. `repairable` is
`false` in that state (§4) so no Repair is offered, and the UI names the remedy
that works.

### 6. Journal

Both outcomes get a line, matching the existing `launch blocked: …` entry at
`lib/actions.mjs:323`:

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

`lib/actions.test.mjs`, alongside the `missing-hooks` cases at `:131` and `:174`.

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
11. Remove drops the id from **both** `inventory` and `selections`, and leaves a
    record that never had an inventory without one.
12. A refusal is worded for a human: a unit that is not on disk reports
    "already gone", never a raw `ENOENT … lstat '/var/…'`.

Each new assertion is proven by mutation: it must redden when the behaviour it
names is reverted, and the ordering test must redden when the read moves.

## Files

- `lib/packs.mjs` — `writeProvisionRecord` gains the inventory parameter
- `lib/actions.mjs` — `orphanedUnits`, the read-before-provision ordering, the
  blocked payload, the journal line, the remove route
- `public/app.js` — the `orphaned-units` branch and its three actions
- `lib/actions.test.mjs`, `lib/packs.test.mjs` — the cases above
