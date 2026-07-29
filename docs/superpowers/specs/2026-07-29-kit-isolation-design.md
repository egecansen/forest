# Kit Isolation — design spec

**Date:** 2026-07-29
**Repos affected:** `APPS/forest` (Node web UI), `SKLS/*` (skill packs)
**Status:** approved by Egecan, pending implementation

## Problem

A forest worktree is created inside the repo it belongs to
(`<repo>/.forest/wt/<slug(branch)>`, `lib/actions.mjs:40`). Claude Code merges
`.claude/settings.json` from ancestor directories, so a session started in that
worktree inherits the **main repo's** hook registrations while
`$CLAUDE_PROJECT_DIR` resolves to the **worktree**. Every hook whose script was
not provisioned into the worktree then fails with `exit 127`.

Measured on `web-test` (2026-07-29, all sessions under `~/.claude/projects`):

| Date | Worktree | Missing-hook errors |
|---|---|---|
| 06-29 | tech-WEBT-249697 | 60 |
| 07-01 | tech-WEBT-248217 | 106 |
| 07-20 | tech-WEBT-247558 | 92 |
| 07-26 | tech-WEBT-249611 | 69 |
| 07-28/29 | tech-WEBT-254523 | 471 + 442 |

Main-repo sessions: 0 errors in every session (the scripts exist there).

Two consequences, the second worse than the first:

1. Console noise — 442 lines in a single session (144 Bash calls × 3 gates).
2. **Silent non-enforcement.** The errors are non-blocking, so `commit-gate`,
   `destructive-command-gate` and the `delivery-gate` Stop hook were registered
   but never ran for a month. The worktree looked gated and was not.

The deeper problem is ownership: a session's tool surface is assembled from
whatever happens to be on the path above it, not from a declared set. The goal
is the opposite — **work is packaged into kits, and a session sees exactly the
kits it was launched with**.

## Decisions

Settled during brainstorming (2026-07-29):

- **Closed box at the repo layer.** The main repo's `.claude/` (hooks, skills,
  settings, CLAUDE.md) must not be inherited. Achieved by moving worktrees out
  of the repo tree.
- **`~/.claude` stays.** Personal settings, global skills, plugins and MCP
  servers keep loading. Measured: 29 user-level hooks, **0** of them
  `$CLAUDE_PROJECT_DIR`-relative — the failure mode above cannot originate
  there. `CLAUDE_CONFIG_DIR` isolation is explicitly out of scope.
- **Worktree root:** `~/.forest/wt/<repo>/<slug(branch)>`.
- **Composable selection.** Kits, individual pack skills and the pack-level
  harness are three separate families, all selectable in one launch. Kits carry
  their own hooks. Kit packaging will eventually absorb the other two families;
  the design must not break while that migration happens.
- **No dependency resolution between kits.** Shared files may be duplicated.

## Architecture

Four pieces. One declaration, one writer, one verifier, one path source.

### 1. Worktree relocation — one path source

`lib/config.mjs` gains `worktreeRoot`, defaulting to `~/.forest/wt`
(`FOREST_WORKTREE_ROOT` env override, like the other keys). Worktree paths
become `<worktreeRoot>/<repo-name>/<slug(branch)>`.

Call sites that stop hardcoding `.forest/wt`:

- `lib/actions.mjs:40` — creation.
- `lib/finish-fixtures.mjs:26` and `lib/finish.test.mjs` — fixtures take the
  root as a parameter.

Discovery needs no change: `lib/discover.mjs:110` enumerates worktrees with
`git worktree list --porcelain`, which is path-agnostic. Legacy worktrees under
`<repo>/.forest/wt` therefore keep appearing in the UI.

`<repo>/.forest/landed.json` (`lib/landed.mjs:6`) stays where it is — it is repo
metadata, not session context.

### 2. Kit packaging — convention first, manifest optional

A kit directory is provisioned by convention. If these paths exist, forest
copies them; no manifest is required:

```
kits/<id>/
  hooks/                → <wt>/.claude/hooks/
  schemas/              → <wt>/.claude/schemas/
  skills/<skill-id>/    → <wt>/.claude/skills/<skill-id>/
  settings.hooks.json   → merged into <wt>/.claude/settings.local.json
  kit.json              → optional
```

`kit.json` exists only for display metadata and for kits that deviate from the
convention:

```json
{
  "id": "flaky-triage-kit",
  "label": "Flaky Triage",
  "description": "Ingest → cluster → rerun → apply loop for flaky suites.",
  "hooks": { "dir": "adapters/claude", "settings": "settings.hooks.json" }
}
```

Unknown keys are ignored. A kit with neither convention paths nor a manifest
provisions as a plain directory copy (today's behaviour), so existing kits keep
working unchanged.

**One writer.** forest provisions from the convention/manifest; it does **not**
run a kit's `install.sh`. That script stays in the kit for non-forest use. The
current breakage traces directly to two writers: `install.sh` writes
`.claude/settings.json` while forest's `mergeHooks` writes
`.claude/settings.local.json` (`lib/packs.mjs:47`), and neither knows about the
other.

### 3. Provisioning — no silent overwrite

`provisionPack` (`lib/packs.mjs:68`) currently copies with
`{ force: true }` in three places (lines 77, 88, 89). Two kits shipping
different versions of the same relative path (e.g. `hooks/lib/audit.sh`) means
last-write-wins, invisibly.

Replace with a hash-aware copy:

- Destination missing → copy.
- Destination present, byte-identical → skip.
- Destination present, different content → **do not overwrite**; append to
  `out.conflicts[]` as `{ path, incoming, existing }` (kit ids).

`provisionPack`'s return grows `conflicts: []`. `lib/actions.mjs` surfaces them
in the journal line, e.g.
`collision: hooks/lib/audit.sh (flaky-triage-kit ≠ hektor-gates)`.

`mergeHooks` already dedupes hook entries by command string
(`lib/packs.mjs:58`), so two kits registering the same gate produce one
registration.

**Provision record.** After a successful provision, forest writes
`<wt>/.claude/.forest-provision.json`:

```json
{ "at": "2026-07-29T07:00:00Z",
  "selections": [{ "pack": "hektor", "kits": ["flaky-triage-kit"], "skills": [], "hooks": false }] }
```

This makes a worktree self-describing (the card can show which kits it runs) and
makes repair a re-run of a recorded input rather than a guess.

### 4. Session scope — one resolver, three consumers

New module `lib/session-scope.mjs`:

```js
resolveSessionScope(worktreePath, { userSettingsPath = '~/.claude/settings.json' })
  → { active: [{ event, matcher, command, file, source }],
      missing: [ …same shape… ],
      inline:  [ …commands with no resolvable file path… ],
      sources: [ absolute settings paths, in merge order ] }
```

It reproduces what Claude Code will actually load:

1. Walk **up** from `worktreePath` to `/`, collecting `.claude/settings.json`
   and `.claude/settings.local.json` at each level. This is what makes the
   inherited-from-ancestor case visible — and it keeps working for the legacy
   nested worktrees that are not being moved.
2. Append the user-level settings file, deduplicating `sources` by real path.
   The dedupe matters because the new worktree root lives under `$HOME`, so
   `~/.claude/settings.json` is reached both as an ancestor and as the
   user-level file — it must be counted once. No other `.claude` directory sits
   between `~` and `~/.forest/wt/<repo>/<branch>`, which is why placing
   worktrees there is inheritance-free in practice.
3. For each registered hook: strip quoting, take the command's first token,
   expand `$CLAUDE_PROJECT_DIR` / `${CLAUDE_PROJECT_DIR}` to `worktreePath` and
   `~` to home. A token that is not a resolvable path (inline shell, a bare
   executable name) goes to `inline` — reported, never counted as missing.
4. `stat` each resolved file: exists → `active`, absent → `missing`.

Three consumers, no new user steps:

| Consumer | Behaviour |
|---|---|
| Picker, before launch | Preview: "this session will load N gates from M sources", `~/.claude` included. Makes the remaining inheritance visible. |
| After provisioning | If `missing` is non-empty, the launch response carries it and the UI warns before the terminal opens. |
| Worktree card | Badge `gates: 12 · missing: 0`; non-zero missing renders red with a **Repair** action. |

**Repair** (`POST /api/worktree/repair`) re-runs `provisionPack` with the
selections from `.forest-provision.json`. If that file is absent (worktrees
created before this change), the action opens the picker instead of guessing.

## UI changes

- Picker: kits, skills and harness stay three separate groups; a scope preview
  line under the launch button.
- Worktree card: kit badge (from `.forest-provision.json`) and gate badge (from
  the resolver). Repair action appears only when `missing` is non-empty.

No change to the launch flow itself: pick, launch.

## Migration

- Existing worktrees stay where they are and keep being listed.
- The gate badge marks the broken ones. `tech-WEBT-254523` is expected to show
  `missing: 16` until repaired or recreated.
- Repair for legacy worktrees is provisioning the missing hooks in place; moving
  them (`git worktree move`) is optional and manual.
- No flag day: new worktrees use the new root, old ones keep working.

## Out of scope

- `CLAUDE_CONFIG_DIR` / `~/.claude` isolation.
- Dependency resolution or shared-library deduplication between kits.
- Rewriting `install.sh` to read `kit.json`; the resolver catches divergence as
  `missing`, which is enough.
- Converting the `hektor` pack's 25 skillsets into kits — that migration is the
  user's, enabled by this design, not part of it.

## Testing strategy

`node --test` (the repo's existing runner), unit-level, no network:

- **Resolver:** fixture tree with a nested worktree under a parent holding
  `.claude/settings.json` → the parent's hooks appear in `missing` with the
  parent settings file as `source`. Same fixture with the scripts present →
  `active`. `$CLAUDE_PROJECT_DIR` expansion, `~` expansion, quoted commands, and
  an inline command classified as `inline`.
- **Hash-aware copy:** identical content → skip, no conflict; differing content
  → original preserved and one `conflicts[]` entry.
- **Kit conventions:** a fixture kit with `hooks/` + `settings.hooks.json` and
  no manifest provisions both; a manifest overriding `hooks.dir` wins.
- **Config:** `worktreeRoot` default, env override, and the computed worktree
  path for a repo/branch pair.
- **Fixtures:** `lib/finish-fixtures.mjs` builds under a caller-supplied root;
  existing `finish` tests pass unchanged against it.

Regression gate for the relocation: the full `node --test` suite green before
the new root becomes the default.

## Risks and their handling

| Risk | Handling |
|---|---|
| `~/.claude` still inherited | Accepted; measured 0 project-relative hooks. Made visible by the picker preview. |
| Silent overwrite between kits | Hash-aware copy + `conflicts[]` in the journal. |
| `install.sh` drifts from the manifest | Resolver reports the undelivered hook as `missing`. |
| Relocation breaks path assumptions | `config.worktreeRoot` as the single source; `node --test` as the gate. |
| A worktree ends up with no gates | Harness checkbox default-on; gate badge on the card. |
| The same class of bug going silent again | Post-provision verification + badge — this is the check whose absence cost a month. |
