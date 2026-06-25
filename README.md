# Forest 🌲

A zero-dependency local web dashboard for tracking git worktrees across all repos
under `~/sahibinden/repo/`, and running Claude on a branch.

## Run

    forest        # starts the server (if down) and opens the dashboard

Or directly:

    node server.mjs

Then open http://127.0.0.1:5577.

## Posture

Forest is a glass cockpit, not an autopilot. Visibility is all-GUI; mutations are
terminal-first. The header **Guided ⟷ Auto** toggle decides whether an action runs
in your terminal (you stay fluent) or in the background (logged to the journal).
Both modes confirm destructive actions and never touch a repo's primary worktree.

## Config

Copy `config.example.json` to `config.json` and edit. Keys: `port`, `roots`,
`jiraBaseUrl`, `staleDays`, `defaultMode`, `terminalApp`, `openEditorCmd`,
`setupScript`.

## Test

    npm test    # node --test over lib/*.test.mjs
