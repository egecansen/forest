# Repo Management — design spec

**Date:** 2026-07-29
**Repos affected:** `APPS/forest`
**Status:** approved by Egecan, pending implementation

## Problem

Forest discovers repos by scanning: every git repo directly under a configured
root, plus the children of each configured container (`lib/discover.mjs`,
`lib/config.mjs:16-17`). Anything that does not match that shape is invisible.

`SKLS/hektor` is the case that surfaced it — a real repo, actively worked on,
two levels below the root under a directory that is not a container. To make it
appear you must hand-edit `config.json` and restart the server, and you have to
know that `containers` is the key that governs it.

Config is currently read once at startup (`server.mjs:18`) and never written.

## Decisions

Settled during brainstorming (2026-07-29):

- **The unit is one repo.** "Add this repo", not "scan this folder". The curated
  list rides on top of the existing root/container scan, which keeps working
  unchanged.
- **Paths are pasted, not browsed.** A small input, validated server-side, with
  a specific error message per failure. No directory browser, no discovery
  suggestions, no drag-and-drop.
- **Forest owns its own state file.** The list lives in `repos.json`, not in the
  user's hand-authored `config.json`, so forest never rewrites a file the user
  edits.

## Architecture

### 1. State — `repos.json`

A file forest owns, beside `config.json` at the forest root:

```json
{ "repos": ["/Users/egecan.sen/sahibinden/repo/SKLS/hektor"] }
```

Absent file → empty list. Malformed file → empty list plus one warning in the
journal; forest must **not** overwrite it, because the file is the only record of
what the user added and clobbering it on a parse error loses that.

New module `lib/repos.mjs`:

```js
readRepoList(forestRoot)              → Promise<string[]>   // never throws
addRepo(forestRoot, path)             → Promise<{ ok: true, repos } | { ok: false, reason }>
removeRepo(forestRoot, path)          → Promise<{ ok: true, repos }>
```

`reason` is one of `not-found`, `not-a-repo`, `already-listed`, `not-absolute` —
the route maps it to a message, so the wording lives in one place.

### 2. Validation

In order, on the resolved path:

1. `~` is expanded; a relative path is rejected (`not-absolute`) rather than
   resolved against the server's cwd, which is not what the user means.
2. The directory must exist (`not-found`).
3. It must be a git repository — `git -C <path> rev-parse --git-dir` succeeds
   (`not-a-repo`). This accepts a worktree or a bare-adjacent checkout without
   forest having to reason about which.
4. It must not already be in the list, compared by **real path**
   (`already-listed`), so a symlinked alias cannot produce a duplicate card.

A repo that the scan already finds is **not** rejected — it is deduped at
discovery (below) and adding it is a harmless no-op from the user's point of
view. Rejecting it would mean explaining the scan's shape, which is exactly the
knowledge this feature exists to make unnecessary.

### 3. Discovery

`buildSnapshot` gains a third source alongside roots and containers: each listed
path is taken directly as a repo. All three sources are merged and deduplicated
by real path, so a repo reachable both ways yields one card.

Each repo record carries `listed: boolean` — true when it came from `repos.json`.
The UI uses it for one thing only: the remove control appears on listed repos and
nowhere else. A repo found by the scan cannot be "removed" — it would reappear on
the next refresh, and offering the control would promise something forest cannot
do.

A listed path that has since been deleted or is no longer a git repo is skipped,
and journalled **once per path per server run** — tracked in an in-memory set, so
a stale entry does not emit a line on every four-second refresh. It stays in
`repos.json`: the user added it deliberately, and a temporarily unmounted disk
must not silently drop their entry.

### 4. API

Two routes, following the existing `handleAction` pattern in `lib/actions.mjs`:

- `POST /api/repos/add { path }` → `{ ok: true, repos }` or
  `{ error: <message> }` with 400. On success: writes `repos.json`, updates the
  in-memory list, broadcasts a fresh snapshot.
- `POST /api/repos/remove { path }` → `{ ok: true, repos }`. Removes the entry
  from the list only. **Nothing on disk is touched** — not the repo, not its
  worktrees, not its `.claude/`. The response is the new list; the UI does not
  guess.

Both are hot: no restart. The server holds the list in memory next to `config`
and re-reads it only at startup.

### 5. UI

- Header: a `+ repo` control opening a single-line form — path input, Add, and an
  inline error slot fed by the route's message.
- Repo group heading: a remove control, rendered only when `listed` is true, with
  a confirm step that states plainly that only the list entry is removed.

No settings panel, no separate list view: added repos appear as ordinary repo
groups with their worktrees, which is the whole point.

## Testing

`node --test`, unit level, real temp-dir fixtures, cleaned up in `finally`:

- `readRepoList`: absent file → `[]`; malformed JSON → `[]` and no write;
  valid file → the list.
- `addRepo`: rejects a relative path, a non-existent path, a non-git directory,
  and a duplicate (including a symlinked alias of an entry already listed);
  accepts a real repo and persists it.
- `removeRepo`: drops the entry, leaves the directory untouched on disk, and is
  a no-op for a path that is not listed.
- Discovery: a listed repo appears in the snapshot with `listed: true`; a repo
  reachable both by scan and by list appears exactly once; a listed path that no
  longer exists is skipped without dropping the entry from the file.

## Out of scope

Directory browser, discovery suggestions, drag-and-drop, per-repo settings
(base branch, stale threshold), reordering, and grouping. None of them are
needed to stop hand-editing `config.json`.

## Risks

- **Two sources of truth for what forest shows.** A repo can now appear because
  of the scan or because of the list, and "why is this here" has two possible
  answers. Mitigated by `listed` being visible in exactly one place (the remove
  control) rather than as decoration.
- **`repos.json` is not versioned.** It is machine-local state, like
  `config.json`; both are gitignored. A teammate cloning forest starts with an
  empty list, which is correct — their repos are not yours.
- **Path validation is not a security boundary.** Every existing route already
  accepts an arbitrary `path` from the client (`/api/git`, `/api/open`,
  `/api/worktree/*`), and forest binds to localhost. These routes do not widen
  that surface; if that trust model ever changes, it changes for all of them at
  once.
