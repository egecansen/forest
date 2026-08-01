# Forest launcher subcommands — design spec

**Date:** 2026-08-01
**Repos affected:** `APPS/forest`
**Status:** approved by Egecan, pending implementation

## Problem

`bin/forest` takes no arguments. It starts the server if the port is not
answering, then opens the browser — that is its entire vocabulary. There is no
way to stop the server, and no way to ask whether it is running.

Stopping it today means finding the process by hand:

    lsof -ti :5577 | xargs kill

That is knowledge which lives in the user's head rather than in the tool. It is
also easy to get wrong: `pkill -f 'node server.mjs'` is the obvious shortcut and
it will happily kill an unrelated project's server.

The script also silently accepts arguments it does not understand: `forest up`
today ignores the argument and runs the start-and-open path.

Separately, and confirmed by inspection on 2026-08-01, every start leaves a
launcher shell behind. The `( ... nohup node server.mjs & )` subshell does not
exit — it survives as the *parent* of the server, reparented to init:

    PID  PPID STAT COMMAND
    41129   1 S    bash /Users/egecan.sen/.local/bin/forest up
    41131 41129 S    node server.mjs

It is idle and harmless, but it is the reason `ps aux | grep forest` is
confusing, and a `down` that kills only the server would leave it behind.

## Decisions

Settled during brainstorming (2026-08-01):

- **Bare `forest` does not change.** Start-if-down then open the browser stays
  the default, because that is the command in muscle memory and in the README.
- **`up` is headless.** `forest up` starts the server without opening a browser,
  so it is usable from scripts and from a terminal where a browser tab would be
  noise. Opening the browser is the bare command's job.
- **PID lookup is by port, not by pidfile.** Forest writes no state file. The
  port is the identity of a running server, and a pidfile would be blind to the
  server the README tells you to start with plain `node server.mjs`.
- **Never kill a stranger.** A PID discovered via the port is killed only after
  its command line is confirmed to be Forest's `node server.mjs`.

## Architecture

One file, `bin/forest`, restructured from a straight-line script into helpers
plus a dispatch. Five commands share port resolution, a liveness probe and a PID
lookup; duplicating those three across five branches is what forces the
refactor.

### Helpers

**`resolve_port`** — the existing symlink-walk to find `DIR`, then the existing
`node -e` read of `config.json` with a 5577 fallback. Carried over unchanged.

**`is_up`** — the existing `curl -s http://127.0.0.1:$PORT/api/config` probe.
Answers *"is Forest serving?"*

**`forest_pid`** — `lsof -ti tcp:$PORT -sTCP:LISTEN`, then for each returned PID,
`ps -o command= -p $pid`, keeping only those matching `*node*server.mjs*`.
Answers *"which process do I kill?"* Prints nothing when the port is free or
when the listener is not Forest.

These are two distinct questions and must not be collapsed into one helper: a
wedged Forest can hold the port while no longer answering `/api/config`, and
`down` has to be able to kill that.

### Commands

| Command | Behaviour |
|---|---|
| `forest` | start if down, then `open` the browser (unchanged) |
| `forest up` | start if down; no browser |
| `forest down` | stop the server |
| `forest status` | report running/stopped, with pid and port |
| `forest restart` | `down`, then `up` (no browser) |

Dispatch is `cmd="${1:-open}"` into a `case`. An unrecognised command prints
usage to stderr and exits 2.

### `down` semantics

Idempotent, and non-hostile to processes that are not Forest:

1. No matching listener → `forest: not running (port 5577)`, exit 0.
2. Port held, but the command line is not `node server.mjs` → print the
   offending command line, exit 1, kill nothing.
3. Otherwise `kill` (SIGTERM), then poll the port for up to 3s; if it is still
   held, escalate to `kill -9`. Report which signal ended it.

Before signalling, `down` records the server's PPID. After the server is gone,
if that PPID is a `bash .../bin/forest` launcher shell and it has no remaining
children, it is killed too. Without this, `down` clears the server but leaves
the stray launcher documented under Problem. This is the one piece of scope
beyond "add two commands", and it is included because a `down` that leaves half
of Forest in the process table has not stopped Forest.

`server.mjs` registers no signal handlers (it is a bare `server.listen`), so
SIGTERM is a clean default-terminate with nothing to flush.

### Exit codes

- `status`: 0 running, 1 not running — so it is scriptable.
- everything else: 0 success, 1 runtime failure, 2 usage error.

## Accepted limitations

- The identity check matches any `node server.mjs`, so a second Forest checkout
  would also match. It would have to be listening on this port to be found at
  all, in which case it is the Forest answering there. Narrowing the match to a
  cwd comparison is not worth the extra `lsof` work.
- `npm test` is `node --test` over `lib/*.test.mjs`. A bash script that binds
  ports and signals processes does not fit that harness, and adding a shell-test
  framework for one 70-line script is not a trade worth making. Verification is
  manual, per the checklist below.

## Verification

Manual, after implementation:

1. `forest down` with the server running → stops it; `forest status` → exit 1.
2. `forest down` again → `not running`, exit 0.
3. `forest up` → starts, no browser opens; `forest status` → pid + exit 0.
4. `forest` (bare) with the server already up → browser opens, no second server.
5. `forest restart` → new pid, still serving.
6. `forest bogus` → usage on stderr, exit 2.
7. `nc -l 5577` squatting on the port → `forest down` refuses, exit 1, `nc`
   survives.
8. After `forest down`, `ps aux | grep forest` shows neither the server nor a
   launcher shell.

## Docs

The README's `## Run` section lists only the bare command; it gains the
subcommand table above.
