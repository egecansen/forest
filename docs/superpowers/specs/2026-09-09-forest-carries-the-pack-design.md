# Forest carries the pack — vendored skill packs, automatic provisioning, and a hardened local API

**Date:** 2026-09-09
**Repos affected:** `APPS/forest` (all code changes). `SKLS/hektor` is moved
into forest as `packs/hektor` and gains one catalog key; its scripts are not
changed.
**Status:** DESIGNED — awaiting review, not implemented.

## Problem

Forest already knows how to provision a worktree: `provisionPack`
(`lib/packs.mjs`) copies a pack's skills, kits and gate scripts into the
worktree's `.claude/`, `registerDispatch` wires them through the dispatcher,
and `wireCursorAxis` (`lib/actions.mjs`) runs the pack's own `install.sh
--harness cursor` to write `.cursor/`. The provision record
(`.claude/.forest-provision.json`), the orphaned-units guard and
`/api/worktree/repair` are all built on that. Four things stand between that
machinery and "clone forest, get the skills, launch, work":

1. **The pack lives outside forest.** `packsDir` defaults to `<root>/SKLS`
   (`lib/config.mjs`), a sibling directory. `SKLS/hektor` is its own git
   repository with no remote, on branch `ft/kit-process-contract`, with the
   Cursor-native refactor still uncommitted (92 entries, including the deleted
   `settings.hooks.json`). A teammate who clones forest gets a dashboard and no
   pack.
2. **Nothing installs unless picked.** `/api/launch` provisions exactly the
   `selections` the picker sends, remembered per worktree path in the browser's
   localStorage (`public/app.js`, `skillKey`). An empty selection installs
   nothing. The Tickets route (`ensureTicketWorktree`) gates on the same
   `selections`. `/api/worktree/create` provisions nothing at all.
3. **The Cursor axis is wired only for a Cursor launch** (`agent === 'cursor'
   && sel.length` in `/api/launch`), and in the ticket route only when the
   selection names one of two skills (`hektorAdapterPack`,
   `CURSOR_ADAPTER_SKILLS`). A worktree opened from a plain terminal in Cursor
   is routed and gated only if forest happened to launch Cursor there once.
4. **Every mutating route is reachable from any web page.** `readBody`
   (`server.mjs`) parses whatever arrives as JSON with no content-type check,
   and no route checks `Origin` or `Host` except `/api/srp/token`. The comment
   at `lib/actions.mjs:933-940` assumes the browser's preflight protects the
   other routes because the client sends `application/json`; it does not,
   because a cross-origin `fetch` with a `text/plain` body is CORS-simple and
   is sent without preflight. Verified against the running server on
   2026-09-09: a POST with `Origin: https://evil.example` and
   `Content-Type: text/plain` to `/api/launch` was parsed and answered
   (`400 agent must be 'claude' or 'cursor'`). Launch, task, open, create,
   remove and repair also act on whatever `path` / `repoPath` the body carries.
   Publishing forest to the team multiplies the number of machines exposed.

One fact this spec does not change: the pack currently has **no Claude-shaped
gates**. Every deny goes through `hektor_deny` in `hooks/lib/cursor.sh`, which
emits Cursor's `{permission: "deny"}` only; the flaky kit's installer accepts
and ignores `--harness`; `catalog.json`'s `hooks` block has no `settings` key,
so `registerDispatch` never runs for the pack's gates. A Claude session gets
the skills and zero enforcement. Restoring that is pack work and gets its own
spec (see Follow-ups).

## Decisions

Settled in brainstorming, 2026-09-09:

- **The pack lives in forest**, at `packs/hektor/`, vendored with `git subtree`
  so its history travels. Forest becomes the single source of truth;
  `SKLS/hektor` is retired once the subtree lands.
- **Automatic provisioning installs the whole pack, on both axes, for the
  repos the pack declares.** `catalog.json` gains `targets`. A pack without
  targets stays picker-only.
- **It runs at worktree creation and is re-checked at every launch**, with
  refresh semantics, skipping the work when the pack has not changed since the
  record was written.
- **Forest first; the pack's Claude gates are a follow-up.** Forest consumes
  whatever the pack declares for Claude, today skills only, and needs no change
  when the gates come back.
- **The local API gets an origin and host check and path validation** in this
  piece of work, because "share with the team" is what turns the finding above
  from a personal risk into a fleet one.
- **The picker stays** as the override, pre-ticked with the automatic
  selection. No direct-launch button: the agent toggle lives in the picker.

## Non-goals

- Restoring Claude-shaped gates in the pack (follow-up spec).
- Headless Cursor. `/api/task` auto mode stays `claude -p`.
- Per-repo overrides of the automatic selection beyond the picker. One config
  switch, `autoProvision`, on or off.
- Consolidating the pack installer's eighteen `jq` spawns (pack follow-up).
- Any change to the dispatcher, the orphaned-units guard, or the shape of the
  provision record's existing keys. New keys are added; nothing is renamed.
- Linux/Windows launch support. Unchanged: macOS only.

## Architecture

Six pieces: a pack directory, a catalog key, one pure selection helper, one
provisioning step called from four places, a picker that pre-ticks, and a
request gate in front of every route.

### 1. Pack home

```
forest/
  packs/
    hektor/            ← git subtree of SKLS/hektor (tracked)
      catalog.json     ← + "targets"
      install.sh
      hooks/ hooks.json schemas/ skills/ agents/ rules/ kits/ scripts/ docs/
```

- `DEFAULTS.packsDir` becomes `join(FOREST_DIR, 'packs')`. `FOREST_PACKS_DIR`
  and the `packsDir` config key keep overriding it, so a developer can point a
  checkout at a scratch pack. The README's "packs to `<root>/SKLS`
  automatically" line is removed.
- Only tracked files travel. The pack's untracked `.claude/` (4.4 MB of
  worktrees), `.superpowers/` (4 MB of review diffs), `node_modules/`, and the
  gitignored kit tarball stay behind. Expected size in forest: about 2.5 MB.
- The pack's own entry points keep working from the new path:
  `packs/hektor/hektor package install` and
  `packs/hektor/scripts/worktree-provision.sh` for people not using forest.
- `.gitignore` in forest needs no change: nothing in it matches `packs/`.

### 2. Catalog targets

`catalog.json` gains one key:

```json
"targets": ["web-test", "test-data-client"]
```

- A target is a repo name **as forest lists it**: the basename of the repo
  directory (`listRepoDirs` in `lib/discover.mjs`, `addRepoRecord` for
  `repos.json` entries). `"*"` matches every repo.
- A pack with no `targets`, or an empty list, is never auto-provisioned.
- `listPacks` passes the key through unchanged (it already spreads the whole
  catalog). No schema validation beyond "array of strings"; anything else is
  treated as absent and journaled once at server start.

### 3. The automatic selection

`lib/packs.mjs`:

```js
export function autoSelections(packs, repoName)
```

Pure. For every pack whose `targets` contains `repoName` or `"*"`, returns

```js
{ pack: cat.pack, skills: cat.skillsets.map((s) => s.id), kits: cat.kits.map((k) => k.id), hooks: !!cat.hooks }
```

This is byte-for-byte the shape the picker sends today, so `runSelections`,
`writeProvisionRecord`, `orphanedUnits`, `recordWithout`, `repairableRecord`
and `/api/worktree/repair` work on it unchanged. Because the automatic
selection is the whole pack, it is a superset of any earlier record's
inventory, so it can never produce an orphan. A skill the catalog names but the
pack does not ship (today `turkce-imla-anlatim`) is skipped by `provisionPack`
exactly as now.

`GET /api/packs?repo=<name>` returns `{ packs, auto }` where `auto` is
`autoSelections(packs, name)`. Without `repo` it returns `{ packs, auto: [] }`.
The client never re-implements the targeting rule.

### 4. The provisioning step

`lib/actions.mjs`, inside `createActionHandler`:

```js
async function ensureProvisioned({ ctx, path, repoName, selections = null, mode, reason })
```

Behaviour, in order:

1. **Off switch.** If `ctx.config.autoProvision === false` and `selections` is
   null, return `{ skipped: 'autoProvision off' }`. An explicit selection is
   honoured regardless of the switch: that is the picker doing what it always
   did.
2. **Choose the selection.** `selections` non-null (the launch route with a
   picker body) wins as-is, after the same filter `/api/launch` applies today.
   Otherwise `autoSelections(await listPacks(packsDir), repoName)`. Empty
   either way returns `{ skipped: 'nothing to provision' }`.
3. **Orphan guard.** Unchanged and in the same place: `orphanedUnits(previous,
   sel)` against the existing record; a non-empty result with no `force` returns
   the same `blocked: 'orphaned-units'` payload `/api/launch` returns today.
   With the automatic selection this branch is unreachable (superset), and a
   test says so.
4. **Fingerprint.** `packFingerprint(packsDir, pack)` returns the pack's git
   tree hash (`git -C <packsDir> rev-parse HEAD:<relative pack dir>`) when the
   pack is inside a git repo **and** `git status --porcelain -- <pack dir>` is
   empty; otherwise `null`. Computed once per request, cached in memory for
   two seconds so a burst of launches does not fork git repeatedly. The step
   returns `{ skipped: 'unchanged', fingerprints }` and journals nothing when
   all three hold: the record's `fingerprints[pack]` equals a non-null current
   value for every pack in the selection; every pack, skill id, kit id and
   `hooks` flag in the current selection is present in the record's
   `selections`; and the record's `cursor.packs` names every selected pack that
   ships an `install.sh`. A
   null fingerprint (a dirty pack, a pack outside git) always provisions: that
   is the developer's editing loop and must never be served stale.
5. **Claude axis.** `runSelections({ refresh: true })`. `copyTree` gains an
   `updated: []` list of destination paths alongside its count; `runSelections`
   journals them by name, capped at ten with "and N more", so an overwritten
   local edit is visible in the journal rather than silent.
6. **Cursor axis, always.** `wireCursorAxis` for every selected pack that ships
   `install.sh`, whichever agent is or is not launching. The existing
   `hektorAdapterPack` / `CURSOR_ADAPTER_SKILLS` special case in the ticket
   route is deleted; `packsWithInstaller` is the only rule.
7. **Record.** `writeProvisionRecord` with two new keys: `fingerprints`
   (`{ [pack]: treeHash | null }`) and `auto: true|false` (whether the
   selection came from the catalog or the picker). `at` is refreshed only when
   something was written.
8. **Journal** one line per outcome: `provision (${reason}): N skill(s), K
   kit(s), gates → .claude/; .cursor/ wired` or the skip reason.

Never throws to its caller; every failure is a `{ error }` plus a journal line,
because the user asked for a worktree or a session, not a gate.

#### Call sites

| Where | `reason` | Notes |
|---|---|---|
| `POST /api/worktree/create`, auto mode | `create` | After `runGit` returns, before the snapshot broadcast. |
| `POST /api/worktree/create`, guided mode | `create` | The Terminal command becomes `git worktree add … && curl -s -X POST -H 'content-type: application/json' --data '{"path":"<wtPath>"}' http://127.0.0.1:<port>/api/worktree/provision`. Provisioning starts only after git exits 0, so it can never race the checkout. The extra clause is visible in the window and in the journal, which is the guided-mode contract. |
| `POST /api/worktree/provision` (new) | `provision` | Body `{ path }`. Path must resolve under `worktreeRoot` or to a listed worktree (see §6). Idempotent. Also usable by hand and by the pack's own script. |
| `POST /api/launch` | `launch` | Replaces the inline `runSelections` + record write + Cursor block. `selections` from the body passes through as the explicit selection; a body without the key means automatic. `launchDecision` for Claude still runs afterwards, now able to see gates provisioning just wrote. |
| `POST /api/task`, both modes | `task` | Automatic selection. Runs before the terminal window or the headless child. |
| `ensureTicketWorktree` | `ticket` | Replaces the `if (selections && selections.length)` block. The route's `selections` field is kept for compatibility and passed through as explicit when non-empty. The Tickets modal (`public/tickets.js`) sends `selections` only when the primary checkout has a saved picker selection, and omits the key otherwise so the automatic selection applies; its Terminal target's `/api/launch` call does the same. Its footer says "skills: automatic (pack targets)" in that case. |

`/api/worktree/repair` is unchanged: it replays the record, which the step
writes in the same shape.

`repoName` comes from the cached snapshot (`findWorktree` → its repo record)
for an existing path, and from `basename(repoPath)` for a path being created.

### 5. Picker

- On open, the client fetches `/api/packs?repo=<name>` and, when no selection
  is stored for the path, pre-ticks `auto`. A stored selection still wins
  (that is the override). A small "auto" tag on each pre-ticked pack says why.
- The empty-state copy changes from "No skill packs found in `SKLS/`" to
  "No skill packs found in `packs/`".
- Launch sends `selections` exactly as today, so an untick goes through the
  existing orphan dialog. Nothing else in the picker changes: agent toggle,
  per-path memory, Remove flow.

### 6. Request gate and path validation

In `server.mjs`, before static files and before `handleAction`:

- **Host.** `req.headers.host` must be `127.0.0.1:<port>`, `localhost:<port>`
  or `[::1]:<port>`. Anything else is `403` with no body read. This closes DNS
  rebinding for every route including `/api/events` and static assets.
- **Origin.** If an `Origin` header is present it must be `http://<that
  host>`. Requests without one (curl, the guided-mode notify, scripts) pass on
  the Host check alone. Exception: `/api/srp/token` keeps its own rule (the
  configured SRP origin), for OPTIONS and POST, exactly as now.
- **Content type.** A POST to `/api/*` must carry `content-type:
  application/json` (parameters allowed). Otherwise `415`, body unread. The
  dashboard's `api()` helper (`public/app.js`) already sends it. The one
  exception is `/api/srp/token`: the bookmarklet in `public/tickets.js`
  deliberately posts `text/plain` so the SRP page's own policy does not force
  a preflight, and that route is already guarded by its exact-origin check on
  both OPTIONS and POST. It keeps accepting `text/plain`, and its origin rule
  is the boundary there, as the comments at `lib/actions.mjs:968-978` say.
- A rejected request is journaled once per (origin, host) pair per server
  process: `refused request from <origin> (host <host>)`, so an actual attempt
  is visible without flooding.

In `lib/actions.mjs`, one helper:

```js
async function managedPath(ctx, p)   // → { ok, kind: 'repo'|'worktree'|'pending', repoName }
```

`ok` when `p` is a repo path or worktree path in `ctx.cachedSnapshot()`, or a
path of exactly the form `<worktreeRoot>/<repo>/<slug>` where `<repo>` is the
basename of a repo in the snapshot and `<slug>` is a single path segment (a
worktree that exists on disk but is not yet in the snapshot, or is about to be
created). `p` is resolved first, so `..` segments and symlinked parents cannot
escape the root. Applied to
`path` / `repoPath` on: launch, task, open, worktree/create, worktree/remove,
worktree/repair, worktree/provision, tickets/worktrees, and (added in the
final review, 2026-09-09) every other route that runs git or deletes files at
a body path: git, worktree/remove-units, worktree/apply-diff,
worktree/finish, worktree/eject. `repos/add` takes an arbitrary path by
design; `repo/prune` re-selects from a fresh snapshot. The description
and priority routes keep their existing `findWorktree` lookup, which already
answers 404 for a path not in the snapshot and is the stricter rule for
read-mostly routes. Failure is `400 path is not a repo or worktree forest
manages`, before anything is read or written. A ctx without a
`cachedSnapshot` function (unit tests only; `server.mjs` always passes one)
is treated as unverified and allowed, keyed on the ctx's shape, which no
request can influence.

### 7. Team distribution

**The README is rewritten in Turkish** (decided 2026-09-09: the team reads
Turkish). The whole of `README.md`, not only the new section: every existing
section is translated, keeping the command lines, config keys, file names and
the config table's key/env/default columns verbatim, since those are
identifiers. The pack's own `packs/hektor/README.md` is pack content and is
not translated. Spec and plan documents stay in English.

README gains **Ekip için kurulum** (Install for the team):

1. Clone forest. Requirements: Node 20 or newer (this machine runs 26), git,
   `jq` (the pack installer needs it), macOS for launching.
2. `ln -s "$PWD/bin/forest" ~/.local/bin/forest`.
3. `cp config.example.json config.json`; set `roots`, `jiraBaseUrl`,
   `jiraProjectKey`, `jiraToken`. `packsDir` is not needed any more and is
   removed from the example.
4. `forest`. Worktrees of `web-test` and `test-data-client` are provisioned on
   creation and re-checked on launch. `git pull` in forest updates the pack;
   the next launch of each worktree refreshes it.

Plus a **Trust** paragraph: the pack's installer, gate scripts and kit
installer run on every teammate's machine at their next launch. Protect
`packs/` with a `CODEOWNERS` entry and required review. Forest only ever
reads the pack from its own checkout; it never fetches one.

And a note on the pack installer's known side effect: it appends a run-state
block to the target repo's tracked `.gitignore` if the block is missing.
`web-test` already carries it; the first launch in another targeted repo
dirties that file once.

## Data shapes

`catalog.json` (addition):

```json
{ "targets": ["web-test", "test-data-client"] }
```

Provision record (additions, existing keys untouched):

```json
{
  "at": "…", "selections": [...], "inventory": {...}, "cursor": {...},
  "fingerprints": { "hektor": "3f9c…" },
  "auto": true
}
```

`GET /api/packs?repo=web-test`:

```json
{ "packs": [ { "pack": "hektor", "targets": ["web-test", "…"], "skillsets": [...], "kits": [...], "hooks": {...} } ],
  "auto": [ { "pack": "hektor", "skills": [...], "kits": ["flaky-triage-kit"], "hooks": true } ] }
```

`config.json` (addition): `"autoProvision": true` (default).

## Error handling

- Installer failure or non-zero exit: journaled with the installer's last
  line, `cursorAdapterError` on the response, session still opens (as today).
- Guided-mode notify never arrives (git failed, window closed): nothing is
  provisioned at creation; the first launch provisions. The create response
  says `provisioning: on first launch` for guided mode.
- Fingerprint cannot be computed: `null`, always provision.
- `copyTree` cross-owner collision in one run: still a conflict, still kept
  existing, still journaled; refresh never overrides that.
- Catalog `targets` malformed: treated as absent; one journal line at startup.
- Request gate failures: `403` / `415`, nothing read, one journal line per
  distinct source.

## Testing

`node --test` over `lib/*.test.mjs`, following the existing fake-`ctx` route
tests in `lib/actions.test.mjs`:

- `packs.test.mjs`: `autoSelections` — targeted repo, `"*"`, no targets, empty
  list, malformed targets; produced shape equals a picker selection.
  `packFingerprint` — clean pack in git, dirty pack, pack outside git.
  `copyTree` reports `updated` paths.
- `config.test.mjs`: `packsDir` default is `<forest>/packs`; env and config
  overrides still win.
- `actions.test.mjs`: `ensureProvisioned` — explicit beats automatic;
  automatic never orphans against a prior partial record; `unchanged` skip
  when fingerprints and coverage match; null fingerprint provisions; the
  Cursor axis is wired for a Claude launch; `autoProvision: false` skips
  automatic but honours explicit. Route tests: create (auto) provisions;
  create (guided) appends the notify clause; provision route accepts a path
  under `worktreeRoot` and rejects one outside; launch without `selections`
  provisions automatically; task provisions before launching; ticket route no
  longer special-cases two skills. `managedPath` on every listed route
  returns 400 for a foreign path.
- `server` gate: a table-driven test over (host, origin, method, content-type)
  → status, including the SRP route's exception and the no-Origin curl case.
- Manual pass, recorded in the plan: create a `web-test` worktree in guided
  and in auto mode; count `.claude/skills/*` and `.cursor/skills/*`, check
  `.cursor/hooks.json` registrations; launch Claude and Cursor; edit one
  provisioned file, relaunch, confirm the journal names the overwrite;
  `git pull` a pack change, relaunch, confirm refresh; relaunch again, confirm
  `unchanged` skip.

## Rollout

Steps the user runs (forest's rule: the agent never commits):

1. In `SKLS/hektor`, commit the pending Cursor-native refactor on
   `ft/kit-process-contract`, and add `targets` to `catalog.json` in that
   commit or the next.
2. In forest:
   `git subtree add --prefix=packs/hektor /Users/egecan.sen/sahibinden/repo/SKLS/hektor ft/kit-process-contract`
3. Remove any `packsDir` line from the local `config.json`; restart forest.
4. Push forest to the shared remote and add the `CODEOWNERS` entry for
   `packs/`.
5. Update the memory note that names `SKLS/hektor` as the kit source of truth.

Existing worktrees need nothing: their first launch after the upgrade
provisions them automatically.

## Follow-ups

- **Pack: restore the Claude axis.** Dual-shape emitters in
  `hooks/lib/cursor.sh` (Claude `hookSpecificOutput.permissionDecision` for
  PreToolUse, exit 2 with stderr elsewhere), a `settings.hooks.json` fragment
  declared under `catalog.json` `hooks.settings`, `install.sh --harness
  claude` writing `.claude/`, and the flaky kit installer honouring the flag.
  Forest needs no change when it lands.
- **Pack: one `jq` program** for the installer's registrations.
- **Direct-launch button** for targeted repos, once the agent choice has a home
  outside the picker.
- **Linux launch support**, if a teammate is not on macOS.
