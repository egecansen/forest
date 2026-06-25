# Forest — Worktree Deck — Design Spec

**Date:** 2026-06-25
**Status:** Approved design, pre-implementation
**Project home:** `~/sahibinden/forest/`

## Summary

Forest is a local web dashboard that shows every git worktree across all repos
under `~/sahibinden/repo/` in one clean, live-updating view, and lets you act on
them — including running Claude Code on a branch. It exists because worktrees are
scattered across ~10 separate repos and spawned by multiple AI tools (Cursor,
Claude Code), with no single place to see or manage them.

Run `forest` (alias `wt`) → a browser tab opens at `localhost`. Done.

## Context (the environment we're building for)

- ~10 **separate** git repos under `~/sahibinden/repo/` (`sui`, `ci`, `quickly`,
  `web-test`, `test-dao`, `admin-e2e-cy`, `web-test-core`, `test-rest`,
  `web-sui-test`, `test-data-client`). Not a monorepo.
- Branches are JIRA tickets: `tech/SUI-238145`, `fun/QUICKLY-245363`,
  `tech/CI-219599`, `tech/WEBT-249514`, etc.
- AI worktrees already exist nested inside repos, e.g.
  `web-test/.cursor/worktrees/web-test/vys8` (detached) and
  `web-test/.claude/worktrees/no-flag-map`.
- macOS 26.2, Node 26 / npm 11, Python 3.14. No bun/go/tmux/gh/lazygit. `claude`
  is on PATH at `~/.local/bin/claude`. `~/.local/bin` is on PATH.

## Goals

- One view of **all** worktrees across **all** repos — the thing no existing
  single-repo tool provides.
- Clean, readable graphical UI (not a TUI).
- Full control: create/remove worktrees, launch agents, run git ops — safely.
- Make running AI on a branch a one-click action.
- Zero install friction; works immediately and offline.

## Non-goals

- No multi-machine / hosted / shared use. Localhost only, single user.
- No replacement for the editor or terminal — Forest launches them, doesn't
  reimplement them.
- No PR/CI integration in v1 (no `gh`, GitHub remote unconfirmed).
- No build pipeline, no framework, no heavy dependency tree.

## Architecture

- **Backend: zero-dependency Node.js** using only built-ins (`node:http`,
  `node:fs`, `node:child_process`, `node:test`). No `npm install`, no build
  step. `forest` just runs `node`. Starts instantly, works offline.
- **Frontend: vanilla HTML/CSS/JS**, no framework/bundler. "Clean and readable"
  is achieved with hand-crafted CSS, not React. Served as static files by the
  Node server.
- **Live updates: Server-Sent Events (SSE)**. The deck subscribes to one event
  stream; the server pushes worktree-state changes, headless-agent output, and
  task lifecycle events. No websocket library.
- **Binding: `127.0.0.1` only.** Never exposed to the network.

### Backend modules (each independently testable)

- `discover.mjs` — scan configured roots for git repos; enumerate their
  worktrees. Pure parsing where possible.
- `git.mjs` — run git commands and parse porcelain output into typed records
  (worktree list, status, ahead/behind, merge state, last commit). Pure parsers
  separated from the exec wrappers so they unit-test cleanly.
- `agents.mjs` — launch interactive Claude, run headless tasks (`claude -p`),
  detect running agent sessions, fire macOS notifications.
- `server.mjs` — HTTP routing, SSE hub, static file serving, action endpoints,
  config loading.
- `public/` — `index.html`, `app.js`, `style.css`.

## Data model

A worktree record the API returns and the UI renders:

```jsonc
{
  "repo": "web-test",
  "repoPath": "/Users/egecan.sen/sahibinden/repo/web-test",
  "path": "/Users/egecan.sen/sahibinden/repo/web-test/.claude/worktrees/no-flag-map",
  "isPrimary": false,            // the repo's main checkout — never auto-pruned
  "branch": "worktree-no-flag-map",
  "head": "d7364cd41f",
  "detached": false,
  "owner": "claude",             // "claude" | "cursor" | "user" (by path)
  "ticket": "WEBT-249514",       // parsed from branch, or null
  "status": { "changed": 3, "staged": 0, "dirty": true },
  "ahead": 0,
  "behind": 0,
  "baseBranch": "master",
  "merged": false,
  "stale": false,                // merged OR no commit in config.staleDays
  "lastCommitAt": "2026-06-24T11:02:00Z",
  "ageDays": 1,
  "sizeBytes": 357564928,        // cached, refreshed async / on demand
  "agent": { "running": true, "kind": "claude", "pid": 12345 }
}
```

### Derivation (git commands)

- **Discover repos:** `readdir` each root; a child is a repo if it has `.git`
  (dir or file). Forest's own home is a sibling of `repo/`, so it never scans
  itself.
- **Worktrees:** `git -C <repo> worktree list --porcelain` → path, HEAD, branch,
  detached, bare, locked.
- **Owner:** path contains `/.cursor/worktrees/` → `cursor`;
  `/.claude/worktrees/` → `claude`; else `user`.
- **Status:** `git -C <wt> status --porcelain=v1` → changed/staged/dirty counts.
- **Ahead/behind:** `git -C <wt> rev-list --left-right --count <base>...HEAD`
  (base = detected default branch).
- **Base branch:** `git -C <repo> symbolic-ref --quiet refs/remotes/origin/HEAD`,
  fallback to `main` then `master`.
- **Merged:** `git -C <repo> merge-base --is-ancestor <branch> <base>`.
- **Last commit:** `git -C <wt> log -1 --format=%cI`.
- **Size:** `du -sk <wt>` — slow, so cached and refreshed asynchronously /
  on demand, never blocking the main snapshot.
- **Agent running:** sessions Forest launches are tracked authoritatively in an
  in-memory registry (pid + worktree). External sessions are detected
  best-effort by matching `claude`/`cursor` processes to worktree dirs; if
  detection is unreliable it degrades to "unknown" rather than lying.
- **Ticket:** first `[A-Z]{2,}-\d+` match in the branch name.

## API endpoints

- `GET  /api/worktrees` — full snapshot (repos + worktrees).
- `GET  /api/events` — SSE stream (state changes, agent output, task lifecycle).
- `GET  /api/diff?path=<wt>` — `git diff` for review in-browser.
- `POST /api/worktree/create` — `{ repo, branch, base }` → `git worktree add`,
  then optional auto-setup script.
- `POST /api/worktree/remove` — `{ path, force? }` → `git worktree remove`
  (client confirms; server refuses primary worktrees).
- `POST /api/launch` — `{ path }` → open Terminal running `claude` in the wt.
- `POST /api/open` — `{ path, target }` → `cursor` | `finder` | `terminal`.
- `POST /api/task` — `{ path, prompt }` → spawn `claude -p`, stream output via
  SSE, notify on finish.
- `POST /api/git` — `{ path, action, message? }` → `fetch|commit|push|pull`.
- `POST /api/fetch-all` — fetch every repo, refresh ahead/behind.
- `GET  /api/config` — current config (for the UI).

## UI / UX

A flat, sortable table of **all worktrees across all repos**, grouped by repo,
with a search/filter bar (type a ticket → instant filter):

```
Repo        Branch / Ticket      Status        Owner    Agent    Age   Size   Actions
web-test    tech/WEBT-249514     ● 3 changed   you      —        2h    1.2G   ⚡ ▶ ⤓ ⋯
  └ .claude no-flag-map          ✓ clean       Claude   ● run    1d    340M   ⚡ ▶ ⤓ ⋯
  └ .cursor vys8 (detached)      ⚠ merged      Cursor   —        5d    280M   🧹 prune
sui         tech/SUI-238145      ✓ clean       you      —        3h    900M   ⚡ ▶ ⤓ ⋯
```

- **Color/badge language:** clean = green, changed = amber, merged/stale = grey
  with a prune nudge, agent running = blue pulse.
- **Row click → detail panel:** in-browser diff, ticket link, full actions,
  live headless-task output.
- **Action icons:** ⚡ quick task · ▶ launch Claude · ⤓ open (Cursor/Finder/
  Terminal) · ⋯ more (git ops, remove) · 🧹 prune (on stale/merged).

## Features

### Primary

1. **All-repos worktree table** with live status, owner, age, size.
2. **Per-worktree diff & status** — in-browser diff viewer.
3. **Create worktree from ticket** — enter `tech/SUI-12345`, choose base →
   `git worktree add`.
4. **Launch interactive Claude** — opens Terminal in the worktree running
   `claude`. The primary "run AI on a branch" path.
5. **Quick-open** — Cursor / Finder / Terminal in one click.
6. **Stale/merged cleanup** — detect orphaned/merged worktrees, one-click prune
   (with confirm; primary worktrees protected).

### Side

7. **Headless quick task** (⚡) — type a small task for a branch → runs
   `claude -p` in that worktree, streams output live, fires a macOS notification
   on finish whose **"Continue interactively"** action drops you into a real
   Claude session in the same worktree. For small fire-and-forget jobs; hands
   off cleanly to interactive when it needs a human.
8. **JIRA ticket deep-link** — branch ticket token links to
   `<jiraBaseUrl>/browse/<TICKET>`.
9. **Auto-setup on create** — after `git worktree add`, run an optional per-repo
   setup script (e.g. `npm install`) so an agent starts with a working tree;
   output streamed.
10. **Fetch-all + git quick actions** — one button to fetch all repos (refresh
    ahead/behind), plus per-worktree commit / push / pull.
11. **⌘K command palette** — keyboard jump to any worktree or action.

## Safety

- Destructive actions (remove/prune) require a client confirm, **never** touch a
  repo's primary worktree, and warn when the worktree is dirty.
- `force` removal is explicit and separately confirmed.
- Everything else is read-only by default.
- Server binds `127.0.0.1` only.

## Configuration

`~/sahibinden/forest/config.json`:

```jsonc
{
  "port": 5577,
  "roots": ["/Users/egecan.sen/sahibinden/repo"],
  "jiraBaseUrl": "",            // user fills in, e.g. https://<org>.atlassian.net
  "staleDays": 14,
  "openEditorCmd": "open -a Cursor",
  "setupScript": ".forest-setup.sh"  // looked up in each repo root; optional
}
```

## Installation / launcher

- A `forest` launcher script (alias `wt`) symlinked into `~/.local/bin/`
  (already on PATH). It starts `node ~/sahibinden/forest/server.mjs` and runs
  `open http://localhost:<port>`. If the server is already up, it just opens the
  tab.

## Testing

- `node:test` (built-in, zero deps) covers the pure logic: worktree porcelain
  parsing, status parsing, ahead/behind parsing, owner detection, ticket
  extraction, stale/merged derivation — against captured fixtures.
- Exec wrappers are thin and kept separate from parsers so the parsers test
  without spawning git.
- UI: manual smoke pass against the real repos.

## Future (explicitly out of scope for v1)

- PR/CI integration once `gh`/remote is confirmed.
- Run-tests-in-worktree with pass/fail surfaced in the row.
- Parallel "same task in N worktrees, compare" agent runs.
- Last-AI-session summary read from `.claude` session logs.
