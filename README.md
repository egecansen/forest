# Forest 🌲

A zero-dependency local web dashboard for tracking git worktrees across all your
repos, and running Claude on a branch. Needs only Node (built-ins only — nothing
to `npm install`). The server binds to `127.0.0.1`.

## Run

    forest        # starts the server (if down) and opens the dashboard

Or directly:

    node server.mjs

Then open http://127.0.0.1:5577.

## Use on another machine

Forest has no hardcoded paths — clone it anywhere and point it at your code.

1. Clone the repo, e.g. `git clone <url> ~/code/forest`.
2. Tell Forest where your repos live (pick one):
   - **Convention (zero config):** if Forest sits at `<root>/APPS/forest`, the
     deck root defaults to `<root>` and packs to `<root>/SKLS` automatically.
   - **`config.json`:** `cp config.example.json config.json` and set `roots`.
   - **Env vars:** `FOREST_ROOTS=/path/a,/path/b FOREST_PORT=5577 node server.mjs`.
3. (Optional) put `bin/forest` on your `PATH`:
   `ln -s "$PWD/bin/forest" ~/.local/bin/forest` — it resolves its own location,
   so it works from anywhere.

> macOS only for now: launching Claude/Cursor and "guided" terminal actions use
> `open`/AppleScript. The dashboard itself is platform-agnostic.

## Posture

Forest is a glass cockpit, not an autopilot. Visibility is all-GUI; mutations are
terminal-first. The header **Guided ⟷ Auto** toggle decides whether an action runs
in your terminal (you stay fluent) or in the background (logged to the journal).
Both modes confirm destructive actions and never touch a repo's primary worktree.

## Config

`config.json` (gitignored, per-machine) overrides the built-in defaults; every
key also has a `FOREST_*` env-var override. Copy `config.example.json` to
`config.json` to start.

| Key | Env | Default | Meaning |
|-----|-----|---------|---------|
| `roots` | `FOREST_ROOTS` | `<install>/../..` | dirs scanned for git repos |
| `containers` | `FOREST_CONTAINERS` | `["APPS"]` | non-git folders whose children are each listed |
| `packsDir` | `FOREST_PACKS_DIR` | `<root>/SKLS` | skill packs the launch picker offers |
| `port` | `FOREST_PORT` | `5577` | server port |
| `jiraBaseUrl` | `FOREST_JIRA_URL` | `""` | links branch tickets to Jira |
| `staleDays` | — | `14` | age before a worktree is flagged stale |
| `defaultMode` | — | `guided` | `guided` or `auto` |
| `terminalApp` / `openEditorCmd` / `setupScript` | — | macOS defaults | launch helpers |

## Test

    npm test    # node --test over lib/*.test.mjs
