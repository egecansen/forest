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

Run `forest` → a browser tab opens at `localhost`. Done.

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
- **Augment the terminal, don't replace it.** Keep the user fluent in raw
  `git`/`claude` — Forest is a glass cockpit, not an autopilot (see Action
  posture).
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
- `agents.mjs` — launch interactive Claude (terminal-first), run headless tasks
  (`claude -p`), detect agent state (in-memory registry + Claude session-file
  heuristic), fire macOS notifications with the "Continue interactively" action.
- `terminal.mjs` — dispatch commands to the user's terminal app / open a terminal
  in a worktree (guided mode), via `open`/AppleScript.
- `journal.mjs` — record every command Forest runs or suggests; expose recent
  entries and stream new ones over SSE.
- `server.mjs` — HTTP routing, SSE hub, static file serving, action endpoints
  (guided/auto dispatch), config loading.
- `public/` — `index.html`, `app.js`, `style.css`.

## Action posture (glass cockpit)

The guiding principle: Forest amplifies the one thing the terminal is bad at
(seeing across ~10 repos at once) and, for everything else, keeps the user in the
terminal and keeps the real commands visible — so `git`/`claude` fluency never
rusts. Visibility is all-GUI; **mutations are transparent and terminal-first.**

### Two execution modes, chosen by a toggle

Every mutating action (create, remove/prune, commit/push/pull, fetch-all,
auto-setup, headless task) runs in one of two modes:

- **Guided (default):** Forest sends the exact command to the user's terminal
  (e.g. `git worktree remove <path>`) for them to run, or opens a terminal in the
  worktree. The user executes it and stays fluent. Forest still updates its view
  from the result.
- **Auto:** Forest runs the command itself in the background, then writes the raw
  command to the command journal so it's still visible.

The toggle has two scopes:

- A **global switch** in the header (`Guided ⟷ Auto`) sets the default for all
  actions. It starts in **Guided**.
- A **per-action override** lets a single action run the other way without
  flipping the global default (e.g. "just auto this one fetch").

The two extreme postures are therefore presets of this one knob: *all guided +
headless hidden* = strict "map, not driver"; *all auto* = full automation. No
feature is added or removed by the toggle — only how/where it executes.

### Command journal

A persistent, always-visible panel logs every `git`/`claude` command Forest ran
or suggested, raw and copy-pasteable. It doubles as a cheat-sheet of the commands
for the user's own repos, and as an audit trail of what auto-mode did. Journal
entries also stream over SSE.

### Terminal target

"Run in your terminal" / "open a terminal here" targets the user's terminal app
(default **Terminal.app** via `open -a`/AppleScript; configurable, e.g. iTerm2).
Interactive Claude launch (▶) is always terminal-first in both modes — it opens a
real terminal running `claude`, never a hidden background process.

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
  "agent": {
    "state": "running",          // "running" | "idle" | "unknown"
    "kind": "claude",            // "claude" | "cursor" | null
    "source": "session-file",    // "registry" (Forest-launched) | "session-file" | null
    "pid": null                  // set only when source === "registry"
  }
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
- **Agent state:** two signals, no `lsof` process-scanning.
  1. *Registry (authoritative):* sessions Forest launches are tracked in-memory
     (pid + worktree) → exact start/stop. `source: "registry"`.
  2. *Session-file heuristic:* Claude Code writes a transcript per project at
     `~/.claude/projects/<path-with-/-and-.-as-->/*.jsonl` (the path encoding is
     confirmed: `/Users/egecan.sen/sahibinden/repo` → `-Users-egecan-sen-sahibinden-repo`).
     `stat` the newest transcript for a worktree's encoded path; mtime within
     ~15s → `running`, else `idle`. Path-keyed, so it catches **any** Claude Code
     session in the worktree — terminal-, Forest-, or Cursor-launched — at the
     cost of one `stat` per tick. `source: "session-file"`.
  - If neither signal is available, `state: "unknown"` (never a confident lie).
    Cursor's *native* (non-Claude) agents leave no such trace and stay
    `unknown`. The heuristic reads Claude's internal layout; if that format
    changes it degrades to `unknown` rather than breaking.
- **Ticket:** first `[A-Z]{2,}-\d+` match in the branch name.

## API endpoints

Mutating endpoints take a `mode: "guided" | "auto"` (default from config /
global toggle, overridable per-action). In **guided** mode the server returns the
exact command and dispatches it to the terminal (or opens a terminal); in
**auto** mode it runs the command itself. Either way it appends to the journal.

- `GET  /api/worktrees` — full snapshot (repos + worktrees).
- `GET  /api/events` — SSE stream (state changes, agent output, task lifecycle,
  journal entries).
- `GET  /api/diff?path=<wt>` — `git diff` for review in-browser (read-only).
- `GET  /api/journal` — recent command-journal entries (backfill on load).
- `POST /api/worktree/create` — `{ repo, branch, base, mode }` →
  `git worktree add`, then optional auto-setup script.
- `POST /api/worktree/remove` — `{ path, force?, mode }` → `git worktree remove`
  (client confirms; server refuses primary worktrees — both modes).
- `POST /api/launch` — `{ path }` → open the terminal running `claude` in the wt
  (always terminal-first; no `mode`).
- `POST /api/open` — `{ path, target }` → `cursor` | `finder` | `terminal`.
- `POST /api/task` — `{ path, prompt, mode }` → spawn `claude -p`, stream output
  via SSE, notify on finish.
- `POST /api/git` — `{ path, action, message?, mode }` → `fetch|commit|push|pull`.
- `POST /api/fetch-all` — `{ mode }` → fetch every repo, refresh ahead/behind.
- `GET  /api/config` — current config (incl. default mode, for the UI).

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

- **Header:** the global `Guided ⟷ Auto` toggle (starts Guided), a fetch-all
  button, and the search/filter box.
- **Color/badge language:** clean = green, changed = amber, merged/stale = grey
  with a prune nudge. Agent state: ● blue pulse = running, ○ grey = idle,
  `?` = unknown.
- **Row click → detail panel:** in-browser diff, ticket link, full actions,
  live headless-task output. Each mutating action shows its exact command and a
  per-action guided/auto override.
- **Action icons:** ⚡ quick task · ▶ launch Claude · ⤓ open (Cursor/Finder/
  Terminal) · ⋯ more (git ops, remove) · 🧹 prune (on stale/merged).
- **Command journal:** a collapsible bottom panel streaming every `git`/`claude`
  command Forest ran or suggested, raw and copy-pasteable.

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
7. **Glass-cockpit toggle + command journal** — global `Guided ⟷ Auto` switch
   with per-action override, and an always-visible journal of every raw command
   (see Action posture). Keeps fundamentals in view.

### Side

8. **Headless quick task** (⚡) — type a small task for a branch → runs
   `claude -p` in that worktree, streams output live, fires a macOS notification
   on finish whose **"Continue interactively"** action drops you into a real
   Claude session in the same worktree. For small fire-and-forget jobs; hands
   off cleanly to interactive when it needs a human. (Visible in Guided mode too,
   since it's opt-in and journaled; hidden only in the strict preset.)
9. **JIRA ticket deep-link** — branch ticket token links to
   `<jiraBaseUrl>/browse/<TICKET>`.
10. **Auto-setup on create** — after `git worktree add`, run an optional per-repo
    setup script (e.g. `npm install`) so an agent starts with a working tree;
    output streamed.
11. **Fetch-all + git quick actions** — one button to fetch all repos (refresh
    ahead/behind), plus per-worktree commit / push / pull.
12. **⌘K command palette** — keyboard jump to any worktree or action.

## Safety

- Destructive actions (remove/prune) require a client confirm, **never** touch a
  repo's primary worktree, and warn when the worktree is dirty — in **both**
  guided and auto modes (the toggle changes *who runs* the command, not the
  guardrails).
- `force` removal is explicit and separately confirmed.
- Every mutating command is appended to the journal, so auto-mode is never
  invisible.
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
  "defaultMode": "guided",      // "guided" | "auto" — global toggle's start state
  "terminalApp": "Terminal",    // terminal to target for guided actions / launch
  "openEditorCmd": "open -a Cursor",
  "setupScript": ".forest-setup.sh"  // looked up in each repo root; optional
}
```

## Installation / launcher

- A `forest` launcher script symlinked into `~/.local/bin/` (already on PATH).
  It starts `node ~/sahibinden/forest/server.mjs` and runs
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
