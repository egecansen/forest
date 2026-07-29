# Follow-ups — kit isolation branch (2026-07-29)

Carried forward from the branch's SDD ledger so the deferred list does not close
with the branch. Each task deferred its Minor findings rather than fixing them
mid-flight; the whole-branch review then triaged them. The three gating findings
and the two strongly-recommended ones were fixed in `dd7c68a` and are not listed
here.

Branch: `f0a6e69..dd7c68a`, 17 commits, 111 tests (baseline 67).

## Worth doing

**Resolve `worktreeRoot` to an absolute path** — `lib/config.mjs:24`. A relative
`FOREST_WORKTREE_ROOT` makes `worktreePathFor` return a relative path, which
`mkdir` and `git -C <repo> worktree add` then resolve against the *server's* cwd
rather than the repo. Wrap the default and any config value in `resolve()`.

**Test the `$HOME` real-path dedup** — `lib/session-scope.test.mjs`. The new
worktree root lives under `$HOME`, so `~/.claude/settings.json` is reachable both
as an ancestor and as the user-level file; deduping by real path is what makes
the new layout "inheritance-free in practice", and it is the one behaviour the
relocation depends on that has no test. `lib/discover.test.mjs`'s
`withIsolatedHome` helper already provides the fixture shape.

**Stop the test suite leaking temp directories** — measured at 28 `mkdtemp`
directories per `node --test` run, with 737 already accumulated on the dev
machine. The newer fixtures (`lib/packs.test.mjs` provisionPack tests,
`lib/actions.test.mjs`) already use `try/finally` + `rm`; apply the same to the
older ones in `packs.test.mjs`, `session-scope.test.mjs`, `config.test.mjs` and
the provision-record tests. This was deferred four separate times, which is how
it reached 737.

**Provision record is last-write-wins while `settings.local.json` is
cumulative** — `lib/packs.mjs:187` vs `mergeHooks`. Launch A (kit X) then launch
B (kit Y) leaves both kits registered but the record naming only Y; a later
repair replays Y and X's hooks stay missing. Either merge selections into the
existing record, or narrow the comment at `lib/packs.mjs:185-186`, which
currently overclaims ("what this worktree was provisioned with").

**Surface the husk directory** — when `git worktree remove` fails, git still
drops `.git/worktrees/<id>`, so the directory disappears from `git worktree
list` while staying on disk, permission-locked and invisible to forest. The
finish toast now reports the failure (`dd7c68a`), but nothing lists the leftover.
`/Users/egecan.sen/sahibinden/repo/web-test/.forest/wt/tech-WEBT-254523` is in
exactly this state today.

**Kit badge** — specified in the design spec, silently dropped from the plan,
never built. Nothing except Repair reads `.forest-provision.json`, so a worktree
still cannot say which kits it runs.

## Fine to leave

- `worktreePathFor` keys on `basename(repoPath)`; two same-named repos under
  different roots would collide at `<worktreeRoot>/<name>/`. Git refuses the
  second `worktree add`, so it fails loudly — but the error will not explain
  itself. A short hash of the full repo path would fix it.
- Empty `<worktreeRoot>/<repo>/` directories are never cleaned up after the last
  worktree under them is removed.
- `lib/session-scope.mjs` walks to `/`, while Claude Code's own walk is bounded
  by the project root — so `active` can over-report from a `.claude/settings.json`
  sitting between the project and `$HOME`. Over-reporting is the safe direction;
  worth one comment saying the choice was deliberate.
- `copyTree` silently skips symlinks and other non-regular entries. The resolver
  reports the consequence as `missing`, so the design's own safety net catches
  it; worth a comment.
- `written` is created per `provisionPack` call, so a conflict between two
  *packs* in one launch is attributed to `'preexisting'` rather than the earlier
  pack. Hoisting the Map to `runSelections` would fix it.
- `kitSkills` is populated and never read; the launch toast under-reports skills
  that arrived via a kit. Aggregate it or drop the field.
- `gateBadge` renders identically for "no hooks" and "resolver threw" — both
  produce empty counts. A `scope: null` on failure would distinguish them.
- `refreshPickerScope` has no request-sequencing guard; reopening the picker on
  another worktree quickly can let a stale response overwrite the text.
- `resolveHookFile`'s single-quote and relative-path branches, and
  `readProvisionRecord`'s malformed-JSON path, are correct but untested — a
  narrowed `catch` would regress the latter silently.
- Assorted test-shape nits: the "not inside repo" assertion passes trivially,
  conflict tests do not assert `copied === 0`, `readKitManifest`'s override test
  covers two of four keys, the fixture's `mkdir(wtRoot)` is redundant, and the
  dedup key uses `|` as a separator.
- The `chmod 0555` fixture in `lib/finish.test.mjs` would pass vacuously under a
  root user. Harmless today; if this suite ever runs in a container defaulting to
  root, the incident's own regression test silently becomes a no-op. Guard it
  with `if (process.getuid?.() === 0) t.skip()` when CI arrives.

## Closed by measurement

- **Per-worktree ancestor walk is not worth caching.** Measured on 22 worktrees
  across 19 repos: `resolveSessionScope` costs 37 ms total (1.7 ms/worktree)
  against a `buildSnapshot` that takes ~4,940 ms — 0.7% of the cycle.
- **Separately worth its own ticket:** that snapshot exceeds its own 4 s refresh
  interval, so cycles overlap continuously. Pre-existing, unrelated to this
  branch.

## Open verification

**The repair happy path has never executed successfully anywhere.** The badge
flipping from `missing N` to clean has not been watched live, because no worktree
has a `.forest-provision.json` and `~/.forest/` does not exist yet — no worktree
has been created under the new root. The unit test on `runSelections` (`dd7c68a`)
is the substitute; a real click-through becomes possible the first time a session
is launched through forest on a new-root worktree.

## Process note for the next plan

Six of this branch's fix rounds had one root cause: the plan's Global Constraints
and its own reference code snippets contradicted each other. The constraint said
"must never throw on malformed input" while the snippet used `|| []`; it said the
destination's mode must match the source while the snippet chmod'ed only on fresh
copies; it specified that Repair opens the picker when no record exists while the
snippet toasted a dead end. Every one of those became a review finding, a
question to the human, and a fix round. When a plan states a constraint, its
sample code must satisfy it — or the constraint should be dropped.
