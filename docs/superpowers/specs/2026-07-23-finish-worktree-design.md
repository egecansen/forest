# Finish Worktree — design spec

**Date:** 2026-07-23
**Repos affected:** `APPS/forest` (Node web UI) and `APPS/idea-worktrees` (IntelliJ plugin)
**Status:** approved by Egecan, pending implementation

## Problem

Worktrees isolate agent work, but reviewing and editing that work is painful:
an IntelliJ project is rooted at one directory path, so seeing a worktree's
changes means opening a second project window (slow re-index, lost context).
The fix is to flip the direction: when a worktree's work is ready, bring its
**branch** into the main checkout the IDE is already open on, instead of
bringing the IDE to the worktree.

"Finish" is that operation, exposed as a button in forest's UI and as an
action in the idea-worktrees plugin.

## Core semantics — the Finish algorithm

Both tools implement the exact same algorithm. This section is the shared
spec; keep the two implementations honest against it.

Given worktree `W`, main checkout `M`, and (eventually) target branch `B`:

1. **Resolve `B` (naming).**
   - `W` is on a branch whose name matches the worktree's name → `B` = that
     branch, **no prompt**. "Matches" is tool-specific: forest compares the
     dir basename to `slug(branch)` (its own naming scheme); the plugin
     treats basename == `slug(branch)` **or** basename ==
     `<project>-<slug(branch)>` (its auto-suggested scheme) as a match.
   - `W` is on a differently-named branch → **prompt**: land under the
     branch's name or the worktree's name? If the worktree name is chosen,
     rename with `git branch -m <old> <worktree-name>`.
   - `W` is detached (the leftover state of a previous keep-the-worktree
     landing) → `B` = the existing same-named branch. No prompt.
2. **Stash carry.** If `W` has uncommitted changes (tracked or untracked):
   `git stash push -u` in `W`. Stashes live in the shared `.git`, so the
   stash is visible from `M`.
3. **Free the branch.** If `W` currently holds `B`: `git switch --detach`
   in `W`.
4. **Land.** In `M`: `git switch B` (or `git switch -c B <W-HEAD>` if `B`
   does not exist). No-op when `M` is already on `B`.
5. **Combine.** In `M`: `git merge <W-HEAD-sha>`. Outcomes:
   - *Already up to date* → no-op (normal on a first landing).
   - Fast-forward or clean merge commit → automatic.
   - **Conflict** → stop cleanly: worktree left intact, stash NOT popped,
     user resolves in the IDE (native IntelliJ merge UI, since the conflict
     is in `M`). Pressing Finish again after resolving resumes: steps 1–5
     become no-ops and execution proceeds to 6.
   - Always merge, never rebase — one conflict resolution pass, native IDE
     support, no multi-step rebase state in the user's working tree.
6. **Pop the stash** in `M` (`git stash pop`). The carried changes appear as
   uncommitted modifications in the IDE for manual review and commit. If the
   pop itself conflicts, git keeps the stash entry — report and continue to
   step 7 with removal skipped (below); the pop does **not** stop here.
   **This step now runs before removal, not after** (changed 2026-07-29): the
   step that returns the user's work must never be downstream of a cleanup
   step that can fail — a worktree left half-removable by a stray read-only
   directory once threw out of `worktree remove` and the pop after it never
   ran, stranding the user's carried changes in the stash with no explanation.
7. **Remove (only if the "remove worktree" checkbox is on).** Guarded by
   `git merge-base --is-ancestor <W-HEAD> B`; if the guard fails (e.g. merge
   still conflicted) or the stash pop from step 6 conflicted, keep the
   worktree and say why — the worktree is the user's fallback copy while
   anything is unresolved, so cleanup must not run yet. Otherwise the
   worktree is deleted with `git worktree remove`, non-fatally: on failure
   (permissions, a lock, a busy directory — reasons unrelated to safety),
   report the error and keep the worktree rather than aborting; the landing
   and the pop have already succeeded by then and must not be thrown away
   over a cleanup failure. This makes losing agent work structurally
   impossible.

### Chosen policies (decided 2026-07-23)

| Situation | Policy |
|---|---|
| Dirty worktree at Finish | Carry as uncommitted (stash → land → pop). |
| Dirty main checkout | Git-native: attempt the switch/merge; git refuses if local edits would be lost or a merge is in progress → abort loudly, touch nothing. Unrelated local edits ride along, which is normal git behavior. |
| Worktree fate | Per-landing checkbox "remove worktree after landing", default **on**. |
| Repeat landings | Fully supported: keep-the-worktree landing leaves `W` detached; a later Finish merges the new detached commits into `B` (step 5) and can then remove. Pressing Finish twice is never an error. |
| Combine strategy | Merge, never rebase. |
| Commits/pushes | Finish never commits user work and never pushes. The user reviews and commits manually. |
| Concurrency | Finish and Eject are serialized per repo inside each tool (forest: per-repo promise queue; plugin: service-level lock) — overlapping operations run back-to-back, never interleaved. |

### Explicitly out of scope

- No interaction with remotes (no fetch/push/PR creation).
- No change to the plugin's existing *Merge into Main* action — that merges
  the feature branch into master's current branch, a different operation.
  Finish makes `M` **switch to** the feature branch.
- No rebase mode.

## forest implementation

### API

`POST /api/worktree/finish` in `lib/actions.mjs`, alongside the existing
worktree actions. Body:

```json
{
  "repoPath": "/path/to/main/checkout",
  "path": "/path/to/main/checkout/.forest/wt/tech-WEBT-251448",
  "targetBranch": "tech/WEBT-251448",
  "remove": true,
  "mode": "auto" | "guided"
}
```

- `targetBranch` is sent by the UI after the naming dialog resolves; the
  server still validates it (rename only fires when it differs from `W`'s
  current branch).
- **auto** mode runs the sequence in-process via `runGit`, journals each
  step, broadcasts a fresh snapshot, and returns `{steps: [...], landed,
  merged, removed, stashPopped, conflict?}`.
- **guided** mode journals and opens a terminal (`runInTerminal`) with the
  exact command sequence so the user runs it themselves — consistent with
  every existing forest action.
- Conflict in auto mode is not an HTTP error: the response reports
  `conflict: true` with the message "resolve in your IDE, then press Finish
  again".

Additionally a state probe used by the UI to build the confirm dialog:
`POST /api/worktree/finish-preview` (body `{repoPath, path}` — POST because
forest's action router reads JSON bodies, not query strings) →
`{worktreeName, branch, detached, nameMismatch, candidates, dirtyCount,
targetBranch, mainBranch, relanding, mergeInProgress}`.
(Implemented server-side to keep git parsing out of the browser; reuses
`parseStatus`/`parseAheadBehind` from `lib/git.mjs`.)

### UI

- A **Finish** button on each non-primary worktree row.
- Confirm dialog shows: resolved target branch (editable only when
  `nameMismatch`, offering the two names from the naming rule), dirty-file
  count ("2 uncommitted files will carry over"), ahead/behind vs master,
  whether this is a first landing or a re-landing ("branch already in main —
  will merge"), and the "remove worktree after landing" checkbox (default
  on).
- Journal lines per step, as with every existing action.

## idea-worktrees implementation

- New `FinishWorktreeAction` registered in `plugin.xml` with shortcut
  `Ctrl+Alt+W, F`, plus a Finish button/context-menu item in the Worktrees
  tool window.
- Implemented natively in Kotlin on the existing `GitWorktreeService` /
  `WorktreeOperations` layer — **no dependency on the forest server**, so it
  works on any worktree layout, not just `.forest/wt/`.
- Confirm dialog mirrors forest's (target branch, dirty count, re-landing
  indicator, remove checkbox).
- On merge conflict the action stops and IntelliJ's own merge UI takes over
  naturally (the conflict lives in the project the IDE has open); a
  notification explains "resolve, then run Finish again".
- After a successful finish: VFS refresh + worktree tool-window refresh
  (the existing `WorktreeChangeListener` machinery).
- Tests mirror the existing action/service test style
  (`WorktreeOperationsTest`, `WorktreeManagementTest`, …): unit tests for
  the algorithm's branch/detached/dirty/re-landing/conflict/ancestor-guard
  cases against fixture repos.

### Duplication note

The algorithm intentionally exists twice (Node + Kotlin) because the plugin
must stay standalone. This spec is the single source of truth; both
implementations link to it and any semantic change lands here first.

## Milestone 2 — Eject/Undo and the safety ref

1. **Eject (undo a Finish).** Reverse operation, in this order: switch `M`
   back to the branch it was on before the landing (freeing `B`), then
   `git worktree add <path> B` to recreate the worktree.
   Forest records the previous branch in the finish journal entry /
   response; the plugin stores it in the project workspace state. Exposed as
   an **Eject** button next to Finish (forest) and an action (plugin). In
   forest, that button lives in the primary worktree's drawer — once a
   worktree is finished its own row disappears, so Eject has nowhere else to
   live.
2. **Safety ref.** Immediately before `git worktree remove`, write
   `refs/forest/landed/<worktree-name>` pointing at `<W-HEAD>` — this happens
   even when the removal that follows fails, since the ref must exist before
   the worktree can disappear. In forest, `recordLanding` (the ledger entry
   Eject consumes) only writes *after* `git worktree remove` actually
   succeeds: writing it while the directory still exists would leave Eject
   unable to do its job (`git worktree add` onto an existing path fails). A
   landing whose removal failed is therefore not yet ejectable. Note that
   `git worktree remove` deletes its own admin registration
   (`.git/worktrees/<id>`) even when the on-disk delete it attempts fails
   partway through, so the leftover directory is left behind as a broken,
   no-longer-a-worktree husk that a second `git worktree remove` cannot pick
   back up (`fatal: '<path>' is not a working tree`); recovery is a manual
   `chmod`/permission fix followed by `git worktree prune` and a plain
   filesystem delete of the leftover directory — not simply pressing Finish
   again. The safety ref and the (now already-popped) stash are what make
   this recoverable rather than a second automatic attempt. Prune refs
   older than 14 days: forest prunes on server start (ledger-driven, using
   each entry's recorded `ts`); the plugin prunes inline after each
   successful removal (no StartupActivity), using the ref target's
   `creatordate` as an age proxy and always skipping the ref it just wrote
   (the proxy is the commit's committer date, so a freshly landed but
   old-committed worktree would otherwise self-prune). Forest additionally
   deletes a landing's safety ref when that landing is ejected. Pure
   insurance on top of the ancestor guard; invisible in normal use
   (`refs/forest/*` is outside `refs/heads/`, so it never shows in branch
   lists). Guided-mode landings write this same safety ref (see
   `finishCommands`) but never touch the ledger — `recordLanding` only runs
   on the auto-mode code path — so Eject, which pops from the ledger, applies
   to auto-mode landings only; a guided landing can only be recovered via the
   safety ref itself.

## Testing strategy

- **forest:** extend the existing `*.test.mjs` suites — algorithm unit
  tests against throwaway fixture repos (branch landing, re-landing merge,
  conflict stop/resume, ancestor guard, stash carry & pop, name mismatch
  rename, guided command generation).
- **idea-worktrees:** Kotlin tests in the existing test style covering the
  same case matrix.
- Manual end-to-end check on the real `web-test` repo with a scratch
  worktree before calling it done.
