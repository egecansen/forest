# Agent choice — Claude or Cursor CLI from ▶ and the Tickets modal, with a healable Cursor axis

**Date:** 2026-09-07
**Repos affected:** `APPS/forest` only. Runs `SKLS/hektor`'s own `install.sh`
(`--harness cursor`) but changes nothing in that pack.
**Status:** DESIGNED — not implemented.

## Problem

Every interactive session forest starts is `claude`. The `.command` file
`lib/terminal.mjs:launchClaudeSession()` writes has `claude` (or
`claude '<prompt>'`) baked into its body; `/api/launch`, `/api/task` (guided)
and the "Continue interactively" button all reach it with no notion of an
agent. The Tickets modal's "Terminal" target is the same call.

Meanwhile the Hektor pack has moved to Cursor:

- `SKLS/hektor/install.sh:179-184` — `--harness claude` prints a WARN and
  installs nothing Claude-shaped: *"installing these gates there would block
  nothing while appearing wired."* (`do_cursor` is set at `:44-50` and never
  read, so `.cursor/` is written for every harness value.)
- `SKLS/hektor/kits/flaky-triage-kit/install.sh:27` — `--harness) shift 2 ;;
  # accepted and ignored: the pack is Cursor-only now`. It writes only
  `.cursor/`.
- `SKLS/hektor/catalog.json` `hooks` has `dir`, `schemas`, `registrations`
  and **no `settings` key** — so `provisionPack` (`lib/packs.mjs:370-380`)
  copies the Cursor-shaped gate scripts into `.claude/hooks/` and
  `registerDispatch` never runs. A Claude session of the Hektor pack today
  gets skills and **zero enforcement**.

And forest's Cursor wiring lives in exactly one place. The pack installer —
the only thing that writes the kernel rule, the 23 skills, the agents and the
18 gate registrations under `.cursor/` — is run by `runCursorAdapterInstall`
from `ensureTicketWorktree` (`lib/actions.mjs:254-273`, `:576-584`), reachable
only through `/api/tickets/worktrees`. Consequences:

1. **▶ never wires the pack's `.cursor/`.** (Ticking the flaky kit writes the
   kit's own slice — its installer ignores `--harness` — but not the pack's.)
2. **↻ repair cannot heal `.cursor/`.** `/api/worktree/repair`
   (`lib/actions.mjs:996-1008`) replays `runSelections`, whose kit installer
   call hardcodes `--harness claude` (`lib/packs.mjs:284`). It never touches
   the pack installer.
3. `.cursor/` is never git-excluded by forest. `ensureHidden` covers
   `/.claude/` only; the pack installer's gitignore block adds only
   `docs/hektor/*`; `writeTicketRule` verifies but deliberately does not write,
   on the stated premise that "the pack's own install" handles it
   (`lib/actions.mjs:491-497`) — which it does not. `web-test` happens to
   carry `/.cursor/` in its shared `.git/info/exclude`; any other repo shows
   ~60 untracked files after a Cursor install.

## Decision

An **agent** is chosen per launch — `claude` or `cursor` (the Cursor CLI,
`cursor-agent`) — from a toggle in the picker and, for the Terminal target, in
the Tickets modal. The choice is remembered per checkout path. The default,
where nothing is remembered, is **Cursor CLI**: that is where the pack's
enforcement lives.

A **Cursor launch wires the Cursor axis** — after provisioning, every selected
pack that ships an `install.sh` is run with `--harness cursor`, the result is
recorded in the provision record, and **↻ repair replays that record** the
same way it replays `.claude/`. One session per worktree still holds,
regardless of agent.

The Claude axis is not changed. Provisioning still writes `.claude/` for both
agents (it is what the provision record and the orphan guard are built on),
and a Claude launch behaves exactly as today.

## Non-goals

- **No Claude-shaped gates for the Hektor pack.** That is the pack's own
  decision (`install.sh:170-178` says how to restore it). Forest reports what
  it finds; it does not manufacture registrations.
- **No headless Cursor.** The ⚡ quick-task auto mode stays `claude -p`. It
  picks up the new `claudeCmd` config key so the setting is not half-applied;
  nothing else changes there.
- **No `--trust`.** `cursor-agent` prompts once per new workspace. Forest does
  not bypass a consent prompt whose exact scope it has not verified.
- **No change to the Tickets modal's Cursor-app target** (worktrees + GUI).
  Only its label changes.
- **No per-skill install on the Cursor axis.** `install.sh` copies the whole
  pack regardless of the picker's checkboxes. The UI says so; forest does not
  try to trim `.cursor/` after the fact.

## Surface — the picker

```
Start a session
~/.forest/wt/web-test/tech-SHBDN-253990
Agent:  ( Claude )  [ Cursor CLI ]
        Cursor CLI installs the whole Hektor pack under .cursor/ — the
        checkboxes below shape .claude/ only, which cursor-agent does not read.
▸ hektor   (22 skills, 1 kit, gates)
▸ superpowers
                18 Cursor gates active         Cancel   [ Start Cursor CLI ]
```

- **Toggle** — `Claude` | `Cursor CLI`, `.pk-agent-btn`, styled like the
  Tickets modal's `.tk-target-btn`. State in
  `localStorage['forest-agent:<path>']`, values `claude` | `cursor`, default
  `cursor`. Written on click, read on open (restore never re-writes).
- **Label it "Cursor CLI", never "Cursor".** The row already has ⤓ "Open in
  Cursor" (the GUI) and the Tickets modal has a Cursor-app target. A third
  "Cursor" reads as the app.
- **The note** under the toggle appears only when Cursor CLI is selected.
- **`#pk-start`** reads `Start Claude` / `Start Cursor CLI`. The `<h3>` is
  `Start a session`. `▶`'s `title` is `Launch a session`.
- **The scope line** (`#pk-scope`, `refreshPickerScope`) follows the toggle:
  Claude → today's `/api/worktree/scope` (settings sources, Claude hooks);
  Cursor → `N Cursor gates active · M missing` from the same route's new
  `cursor` block (below), or, when the worktree has no `.cursor/hooks.json`,
  `no .cursor/ yet — Start installs the selected pack(s)` / `no .cursor/ yet
  — tick a pack and Start installs it` depending on whether anything is
  ticked (Start only wires the Cursor axis for a non-empty selection — see
  Route) — the line follows the selection too.
- **"Continue interactively"** (`renderTaskPanel`) and the guided ⚡ path send
  the remembered agent too; today they send `{ path }` only and would always
  be Claude.
- **Every "Claude" string keyed on the agent:** `reportLaunched` (three
  places), the "Claude will start with no extra skills" line, the
  missing-hooks confirm (Claude only — Cursor never reaches it, see Route).

## Surface — the Tickets modal

```
Launch target:  [ Terminal ]  ( Cursor app )
   Agent:       ( Claude )  [ Cursor CLI ]      ← shown only for Terminal
   Terminal: one session in the primary checkout, seeded with the prompt.
   Cursor app: one worktree + branch per ticket, then one Cursor window …
```

- The existing target buttons keep `data-target="terminal"` /
  `data-target="cursor"` and the stored value under
  `forest-launch-target:<repoPath>`. **Only the label** changes, to
  `Cursor app`. Renaming the value would reset every repo's remembered
  target to Terminal (`setLaunchTarget` coerces unknowns).
- The agent sub-toggle reads and writes the **picker's** key,
  `forest-agent:<target.primaryPath>` — that path is exactly where
  `startTerminal` launches, and `savedSelections(target.primaryPath)` already
  shares the picker's `forest-skills:` key the same way. No second key.
- `startTerminal()` and `forceLaunch()` send `agent`. The Start button and
  the count line name it: `Start ticket session (Cursor CLI)`.
- `.tk-target-note` gains a Cursor-CLI sentence. Whether `cursor-agent`
  fires `subagentStart` hooks from `.cursor/hooks.json` is **unverified**; the
  note must not claim the Agent-matcher gates come across on the CLI either.

## Launcher — `lib/terminal.mjs`

`launchClaudeSession` becomes

```js
launchAgentSession({ worktreePath, agent = 'claude', cmds, app, title, prompt, openImpl })
```

- `cmds` is `{ claude: 'claude', cursor: 'cursor-agent' }` from config (see
  Config). The body line is `<cmd>` or `<cmd> '<quoted prompt>'` — the
  quoting is unchanged; `cursor-agent` takes an initial prompt positionally
  and `--workspace` defaults to cwd, so the existing `cd` suffices.
- An `agent` outside `cmds` throws; the route validates first, so this is a
  programming error, not a user path.
- **One lock per worktree, not per agent.** The lock file keeps its name
  (`$TMPDIR/forest-sessions/<slug>.pid`) and its content becomes
  `<pid> <agent>` (`echo "$$ cursor" > lock`). `sessionAlive` parses the
  first field; a lock written before this change (bare pid) still parses and
  reads as agent `claude`.
- The focused branch returns `{ ok, action: 'focused', agent: <from lock> }`
  so a toast can say which agent is already running in this worktree — a
  Claude session being alive is exactly why a Cursor launch here must not
  start.
- `runInTerminal`, `openTerminalAt`, `openWith` (GUI `cursor` target) and
  `openCursorWorkspace` are untouched.

`lib/agents.mjs:launchInteractive` passes `agent` and `cmds` through.
`runHeadless` spawns `cmds.claude` instead of the literal `'claude'`.

## Route — `/api/launch`

Body gains `agent: 'claude' | 'cursor'`; absent → `'claude'` for the wire
(the *client* supplies the remembered default — the server never guesses).
Anything else → `400 { error: "agent must be 'claude' or 'cursor'" }`.

Order, with what changes marked:

1. Orphan guard — unchanged. It compares records, not harnesses.
2. Provision `.claude/` via `runSelections` — unchanged, both agents.
3. **Cursor axis (new, `agent === 'cursor'` only):** for every pack in `sel`
   whose `<packsDir>/<pack>/install.sh` exists, run
   `runCursorAdapterInstall({ packsDir, pack, worktreePath, noKits: true })`.
   Gated on `sel.length` exactly like provisioning: the only retry that
   reaches here is the orphan one, which carries real selections. No record
   fallback is needed because Cursor skips step 4 and so never produces the
   `selections: []` retry.
   - Success: `writeProvisionRecord` gets a fourth slot, `cursor: { packs:
     [...], at }`, merged over the record step 2 wrote. Then
     `ensureExcluded(wt, { checkPath: '.cursor/hooks.json', pattern:
     '/.cursor/' })`; a `false` is journalled as a WARNING, the same line
     `writeTicketRule` uses.
   - Failure: journalled, returned as `cursorAdapter: { error }`, **not
     blocking** — the same contract as the worktrees route. The launch goes
     ahead and the toast says the gates did not land.
4. `launchDecision` (missing Claude hooks) — **Claude only.** It reads
   `.claude/settings*.json` + `~/.claude/settings.json`; none of that loads
   in `cursor-agent`, and the dialog it feeds says "Launch Claude with…".
5. Launch — `launch({ worktreePath, agent, cmds, app, title, prompt })`.
   Journal line is `cursor-agent '<prompt>'` / `cursor-agent` for Cursor.
6. Scope in the response — Claude: `resolveSessionScope` as today. Cursor:
   `resolveCursorScope` (below). Shape stays `{ active, missing }` so
   `reportLaunched` needs one branch, not two.

Response: `{ ok, action, agent, provisioned, promptSent, scope, cursorAdapter? }`.
`agent` is echoed so the client's toast is keyed on what the server did.

`/api/task` in guided mode accepts the same `agent` field with the same
validation and hands it to `launch`; auto mode ignores it (headless stays
Claude — see Non-goals). No provisioning happens on that route today and none
is added.

`runCursorAdapterInstallDefault` gains `timeout: 180000` (the kit installer
already has it; the pack installer now runs a JDK probe and had none) and a
`noKits` option that appends `--no-kits`. **Both callers pass it.**
`runSelections` has already run the selected kit's own installer one step
earlier; without the flag the pack install ran it a second time. This changes
the arg list the worktrees-route test pins with `deepEqual`
(`lib/actions.test.mjs:~2118`); that assertion is updated, not worked around.

## `resolveCursorScope` — `lib/session-scope.mjs`

```js
resolveCursorScope(worktreePath) → { active: [...], missing: [...], file }
```

Reads `<wt>/.cursor/hooks.json`. Every registration across every event is
`{ command }`; every Hektor command is a relative `./.cursor/hooks/<x>.sh`
(`SKLS/hektor/hooks.json`). A relative command is `stat`ed under the
worktree; present → `active`, absent → `missing` (`{ event, command }`). A
command that is not a relative path is counted active — forest cannot judge
an absolute path or a bare binary, and must not report it missing. No file →
`{ active: [], missing: [], file: null }`. Never throws.

`/api/worktree/scope` returns it as `cursor: { active, missing, file }` next
to today's fields, so the picker's scope line and `refreshPickerScope` read
one route.

## Repair — `/api/worktree/repair`

After the `.claude/` replay, **if the record says the Cursor axis was wired**
— `rec.cursor?.packs?.length` — replay it: the same `runCursorAdapterInstall`
call per pack, `noKits: true`, then `ensureExcluded`. On success the record's
`cursor.at` is refreshed; on failure the old entry stands and the error is
returned.

Worktrees wired **before this field existed** (every worktree the tickets
route has ever created) have no `rec.cursor`. For those only: if
`<wt>/.cursor/hooks.json` exists, replay for every pack in `rec.selections`
that ships an `install.sh`, and write `cursor.packs` on success so the next
repair is record-driven. A bare `.cursor/` directory is **not** a signal —
`writeTicketRule` creates `.cursor/rules/ticket-*.mdc` unconditionally.

Response gains `cursor: { wired: n, error? } | null` (`null` = nothing to
replay). The ↻ toast: `Refreshed · 3 hooks active, 0 missing · Cursor gates
re-wired — restart any session already running here`, or `· Cursor axis NOT
re-wired: <error>`.

`recordWithout` (`lib/actions.mjs:168-194`) rebuilds the record from
`selections / inventory / at` only. It **must carry `cursor` through**, or
`/api/worktree/remove-units` silently drops the Cursor axis from the record
and the next repair stops healing it.

## Provision record

```json
{
  "at": "…", "selections": [...], "inventory": {...},
  "cursor": { "packs": ["hektor"], "at": "…" }
}
```

`writeProvisionRecord(worktreePath, selections, inventory = null, at = null,
cursor = null)` — `cursor` is written only when given, so records written by
a Claude launch are byte-identical to today's. `readProvisionRecord` is
unchanged.

## Agent column — `lib/agents.mjs:detectAgentState`

One new signal, checked after the registry and before the `.jsonl` heuristic:
forest's own lock. If `$TMPDIR/forest-sessions/<slug>.pid` parses as
`<pid> <agent>` and `process.kill(pid, 0)` succeeds →
`{ state: 'running', kind: <agent>, source: 'lock', pid }`. `agentCell`
already renders `kind` when running, so a Cursor session shows as `● cursor`
with no client change. A stale lock is left alone here — `sessionAlive` in the
launcher is the one that cleans it, and a read-only snapshot must not unlink
files.

## Config

Two keys next to `terminalApp` / `openEditorCmd`, in `DEFAULTS` and
`config.example.json`:

```
claudeCmd:       'claude'
cursorAgentCmd:  'cursor-agent'
```

Both resolve through the Terminal's own `$PATH` (`~/.local/bin` for both
binaries here). `cmds` handed to the launcher is
`{ claude: config.claudeCmd, cursor: config.cursorAgentCmd }`.

## Failure modes

| Case | Behaviour |
|---|---|
| `agent` not in the enum | 400, nothing provisioned, nothing launched. |
| A Claude session is alive and the user starts Cursor CLI (or vice-versa) | `focused`, Terminal brought to front, toast names the agent actually running. Prompt not delivered — `promptSent: false`, same as today. |
| `install.sh --harness cursor` fails or times out | Journalled, `cursorAdapter.error` returned, session still launches, toast says gates did not land. |
| `ensureExcluded` fails | WARNING journalled; launch proceeds. |
| Cursor launch, `sel` empty (nothing ticked, or "Continue interactively") | No provisioning, no Cursor install — same as a Claude launch with nothing ticked. The picker note is what tells the user the pack is not being installed. |
| `.cursor/hooks.json` present but a gate script missing | Scope reports it missing; the launch is **not** blocked (the missing-hooks block is Claude-only by design — see Route). |
| `remove-units` on a record with `cursor` | `cursor` carried through unchanged. |
| Old lock file with a bare pid | Parses as `claude`. |

## Testing

`node --test lib/*.test.mjs`. TDD per unit; the existing tests are
property-level (`seen[0].prompt`), so `agent` in the launch call breaks none
of them — only the one `deepEqual` on the worktrees-route adapter args moves.

- **terminal.test.mjs** — Cursor body is `cursor-agent '<quoted>'`; lock
  content is `<pid> <agent>`; focused branch returns the lock's agent; a bare
  old-style lock reads as `claude`; unknown agent throws.
- **agents.test.mjs** — `detectAgentState` reports `{ running, kind:
  'cursor', source: 'lock' }` from a live lock, and falls through on a dead
  pid or a missing file.
- **session-scope.test.mjs** — `resolveCursorScope`: all present; one
  missing; non-relative command counted active; no file → empty.
- **actions.test.mjs** — `/api/launch`: agent passes through; 400 on
  garbage; Cursor runs the adapter once per selected pack that has an
  `install.sh` (stubbed `runCursorAdapterInstall`; the test drops an
  `install.sh` into the temp `packsDir`, the way the worktrees-route tests
  already build their fixture) with `noKits: true`; Cursor skips
  `launchDecision`; Cursor with `sel: []` runs no adapter; adapter failure
  does not block; record gains `cursor`; `ensureExcluded` called on success.
  `/api/worktree/repair`: replays `rec.cursor.packs`; legacy `.cursor/hooks.json`
  fallback writes `cursor` on success; a record without either runs nothing.
  `remove-units`: `cursor` survives.
- **packs.test.mjs** — `writeProvisionRecord` with and without `cursor`.
- **Manual** — the two toggles' persistence and labels are DOM code with no
  test harness in this repo; verified by hand in the browser per the existing
  convention.

## Build order

1. `terminal.mjs` — `launchAgentSession`, lock format. Tests.
2. `config.mjs` + `config.example.json` — the two keys.
3. `agents.mjs` — pass-through, `runHeadless` uses `cmds.claude`, lock signal
   in `detectAgentState`. Tests.
4. `session-scope.mjs` — `resolveCursorScope`. Tests.
5. `packs.mjs` — `writeProvisionRecord` `cursor` slot. Tests.
6. `actions.mjs` — `runCursorAdapterInstall` timeout + `noKits`; `/api/launch`
   agent + Cursor axis; `/api/worktree/scope` `cursor` block;
   `/api/worktree/repair` replay; `recordWithout` carries `cursor`; `/api/task`
   guided agent. Tests, including the moved `deepEqual`.
7. `public/` — picker toggle + note + labels + scope line; Tickets sub-toggle
   + relabel + note; `reportLaunched` keyed on `r.agent`; "Continue
   interactively" and ⚡ send the agent. CSS for `.pk-agent-btn`.
8. Hand check: ▶ → Cursor CLI on a fresh worktree of a repo that does not yet
   exclude `.cursor/` — `git status` clean, `.cursor/hooks.json` present,
   `cursor-agent` opens with the prompt; ↻ after deleting one gate script
   reports it missing, then re-wires it.

## Appendix — what was verified, 2026-09-07

- `cursor-agent --help`: `prompt` positional ("Initial prompt for the agent");
  `--workspace <path>` "defaults to current working directory"; `--trust`
  exists; `-p` exists. Binary at `~/.local/bin/cursor-agent`, same dir as
  `claude`.
- `SKLS/hektor/install.sh`: `--no-kits` flag exists (`:18-20`, `:34`);
  `do_cursor` never read; Claude-axis WARN at `:179-184`; gitignore block
  `:115-135` covers `docs/hektor/*` only.
- `SKLS/hektor/hooks.json`: every `command` is `./.cursor/hooks/<x>.sh`.
- `SKLS/hektor/catalog.json` `hooks`: no `settings` key.
- `web-test/.git/info/exclude:14` has `/.cursor/` (pre-existing, not
  forest's doing).
- `lib/actions.test.mjs`: launch assertions are `assert.equal(seen[0].prompt,
  …)`; `ctx.journal.entries.at(-1).cmd === 'claude'` pins the default
  journal line only; the adapter-args `deepEqual` is at `~:2118` and is the
  worktrees route's.
- `createActionHandler` already injects `launch`, `resolveScope`,
  `openCursorWorkspace`, `runCursorAdapterInstall`.
- `agentCell` (`public/app.js:74`) renders `a.kind` when running — the lock
  signal needs no client change.
