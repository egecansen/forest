# Prune stale worktrees — design spec

**Date:** 2026-08-01
**Repos affected:** `APPS/forest`
**Status:** approved by Egecan, pending implementation

## Problem

Worktrees accumulate. A repo picks up one per ticket, they land, and the
checkouts stay on disk — `web-test` currently carries about ten under
`~/.forest/wt/web-test/`, most of them long since merged.

Removing them one at a time is possible today (`/api/worktree/remove`, the ✕ on
each row), but nothing answers "which of these are safely disposable?", and the
branch is left behind either way. So they are never cleaned up.

There is a second cost. `buildSnapshot` runs `status`, `rev-list`, `log` and
`merge-base` per worktree, on a 4-second interval (`server.mjs:121`). Every dead
worktree is a permanent tax on that loop.

## Decisions

Settled during brainstorming (2026-08-01):

- **The three words are AND-ed, strictly.** A worktree is prunable only when it
  is old *and* empty *and* unused. The rule is deliberately conservative: the
  worst outcome must be deleting a checkout the user has to re-create, never
  losing work.
- **Nothing is deleted on the first click.** The button computes candidates and
  shows them. Deleting takes a second, explicit confirmation.
- **Safe git only.** `git worktree remove` without `--force`, `git branch -d`
  without `-D`. Git gets the final veto.
- **Local only.** Remote branches are never touched.

## The predicate

`lib/prune.mjs`, a pure function alongside the existing `staleFrom` in
`discover.mjs`:

```js
prunable(wt, { staleDays }) // -> { ok: true } | { ok: false, reason }
```

It returns a reason rather than a boolean so the preview can explain what it
kept. All of the following must hold:

| Condition | Field | Keep-reason when it fails |
|---|---|---|
| not the repo's primary checkout | `isPrimary === false` | `primary` |
| not locked | `locked === false` | `locked` |
| no agent running in it | `agent.state !== 'running'` | `agent-running` |
| no uncommitted changes | `status.dirty === false` | `dirty` |
| no commits of its own | `ahead === 0` | `has-commits` |
| older than the stale threshold | `ageDays >= staleDays` | `too-recent` |

Notes that are part of the contract, not commentary:

- **`ageDays === null` counts as too-recent.** A worktree with no commits at all
  has no age signal; treating it as old would make a just-created empty worktree
  prunable, which is the opposite of the intent.
- **`ahead === 0` implies merged.** `ahead` counts commits on HEAD that are not
  in base, so zero means the branch is already an ancestor of base. This is why
  `git branch -d` is sufficient and `-D` is never needed. **This holds only
  after the detached-worktree fix below** — without it, `ahead` is a hardcoded
  0 for detached worktrees and proves nothing.
- **`agent.state` is `running` | `idle` | `unknown`**, where `running` means a
  Claude session file was touched within 15s (`lib/agents.mjs:10`). Only
  `running` blocks a prune; `idle` and `unknown` do not.

### Required upstream fixes

Two gaps in `lib/discover.mjs` that the predicate cannot be sound without. Both
were found by checking the spec against the code rather than assuming.

**1. `locked` never reaches the record.** `parseWorktreeList` sets it
(`lib/git.mjs:31`) but `buildWorktreeRecord` does not copy it, so it is absent
from the snapshot and the UI. Add `locked: wt.locked` to the returned record
(`lib/discover.mjs:99-120`).

**2. Detached worktrees report a fake `ahead === 0`.** `discover.mjs:83` guards
the ahead/behind and merged computation behind `!wt.detached && wt.branch`, so
every detached worktree reports `ahead: 0, behind: 0, merged: false` regardless
of what it actually holds.

This is a work-loss hole, not a cosmetic one. A detached HEAD's commits are
reachable only from that worktree; remove it and they become unreferenced.
Pruning on a hardcoded zero would delete them silently. Detached worktrees are
also the normal leftover of a "keep the worktree" landing (finish spec step 3
runs `git switch --detach`), so they are exactly the population this button
targets — excluding them instead is not an option.

Fix: compute the counts for detached worktrees too, against `HEAD` rather than
the branch name:

```js
let ahead = 0, behind = 0, merged = false, lastCommitMs = 0;
if (wt.branch || wt.detached) {
  const ab = await safe(() => runGit(path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]), '0\t0');
  ({ ahead, behind } = parseAheadBehind(ab));
  const ref = wt.branch || 'HEAD';
  merged = await safe(async () => {
    await runGit(wt.branch ? repoPath : path, ['merge-base', '--is-ancestor', ref, base]);
    return true;
  }, false);
}
```

`merge-base` runs in the worktree for the detached case because `HEAD` only
resolves to that worktree's head from inside it. This also corrects what the
existing UI shows for detached rows today.

## Endpoints

Both in `lib/actions.mjs`, following the existing `dispatchGit` / journal /
broadcast pattern.

### `POST /api/repo/prune-preview`

Body `{ repoPath }`. Reads the current snapshot, runs `prunable` over that
repo's worktrees, returns:

```json
{
  "candidates": [
    { "path": "...", "branch": "tech-WEBT-233021", "ageDays": 38,
      "sizeBytes": 149000000, "detached": false }
  ],
  "kept": [ { "path": "...", "reason": "dirty" } ]
}
```

Read-only. Runs no git mutation.

**`sizeBytes` is measured here, not read from the snapshot.** The record's
existing `sizeBytes` field (`discover.mjs:117`) reads a `sizes` map that
`server.mjs:22` creates and never populates — it is always `null`. Rather than
fill that map on the 4-second loop, which would add a `du` per worktree to the
storm this feature exists to reduce, the preview shells out to `du -sk <path>`
once per candidate at click time. A `du` failure yields `null` and the dialog
shows `—`; it never blocks the prune.

### `POST /api/repo/prune`

Body `{ repoPath, paths: [...] }` — the explicit list the user confirmed.

**It re-runs `prunable` against a fresh snapshot before deleting anything**, and
skips any path that no longer qualifies. Without this, a worktree an agent
started writing to while the confirmation dialog was open would be deleted on
evidence that was already stale. Any path not present in the server's own
candidate set is refused, so the endpoint cannot be driven to delete an
arbitrary directory.

## Execution

Per candidate, in order:

1. `git worktree remove <path>` — no `--force`.
2. `git branch -d <branch>` — no `-D`; skipped when the worktree is detached
   (there is no branch to delete).

If step 1 fails, step 2 is skipped for that candidate: a deleted branch with a
surviving worktree is a worse state than an un-pruned pair. A failure on one
candidate does not abort the others; each is independent and the result reports
per-item outcomes.

Every command goes to the journal individually, matching how `executeFinish`
reports steps.

`git branch -d` is a real second safety net, not ceremony. The predicate already
guarantees the branch is merged, so `-d` should never refuse. If it ever does,
the predicate was wrong about that worktree and git stops the deletion.

## Guided vs Auto

Unchanged posture (README: "mutations are terminal-first"):

- **guided** — build the full `git -C <repo> worktree remove <path> && git -C
  <repo> branch -d <branch> && ...` chain and hand it to `runInTerminal`, the
  same shape `/api/worktree/remove` uses today. The user watches it run.
- **auto** — run in-process via `runGit`, journal each step, then
  `ctx.broadcast('worktrees', await ctx.snapshot())`.

## UI

`public/app.js`, repo header (currently line 132, beside `+ worktree`):

    [ + worktree ]  [ prune ]  [ ✕ ]

Clicking calls the preview endpoint and opens a dialog:

    Prune 3 worktrees in web-test?

      tech-WEBT-233021    38d    142 MB
      tech-WEBT-238801    21d     89 MB
      tech-WEBT-248762    19d      —      (du failed)

      Branches are deleted with `git branch -d` (merged only).
      Kept 6: 2 dirty, 1 agent running, 3 too recent.

              [ Cancel ]   [ Prune 3 ]

With zero candidates the dialog still opens and reports the keep-reasons, rather
than presenting a button that appears broken.

## Testing

`lib/prune.test.mjs`, using the existing `lib/finish-fixtures.mjs` harness for
real temp repos.

**Predicate** — one case per keep-reason (primary, locked, agent-running, dirty,
has-commits, too-recent), one for the all-clear, and one for `ageDays === null`
returning `too-recent`.

**Upstream fixes** — in `lib/discover.test.mjs`: a locked worktree surfaces
`locked: true`, and an old **detached** worktree holding a commit that is not in
base reports `ahead > 0` (so `prunable` keeps it). That second test is the
regression guard for the work-loss hole; it must fail against the current
`discover.mjs`.

**Execution** — over real repos:
- merged + old worktree: removed, branch gone
- dirty worktree: survives, branch survives
- detached worktree: removed, no branch delete attempted
- `worktree remove` fails: branch is left intact
- one candidate failing does not stop the next

**Re-validation** — a path that passes preview but is dirty at execution time is
skipped and reported.

## Out of scope

- Remote branch deletion.
- Pruning across all repos at once; this is per-repo.
- Any change to `staleDays`, which stays the existing config key (default 14).
- Per-row checkboxes in the dialog. The AND-ed rule makes every candidate safe,
  so selective pruning is not worth the UI.
