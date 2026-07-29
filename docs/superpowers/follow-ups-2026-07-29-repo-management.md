# Follow-ups — repo management (2026-07-29)

Carried forward from the SDD ledger so the deferred list does not close with the
work. Five tasks each deferred their Minor findings; the whole-branch review
triaged them, and its three gating findings plus the CSS were fixed in `90becf0`.
What remains is below.

Range: `af8bc7c..90becf0`, 133 tests (124 when this work started).

## Worth doing

**Enter bypasses the Add button's in-flight guard** — `public/app.js:587`. The
button is disabled during the request, but the `keydown` handler calls
`addRepoFromForm` directly, so a fast double-Enter still fires two concurrent
adds. Harmless at the data layer now that writes are serialized, but the second
call writes `Already added.` into an error slot the first call already hid.
Guard on a module-level in-flight flag rather than the button's `disabled`.

**No route-level tests for `/api/repos/*`** — the ctx contract these routes
depend on (`forestRoot`, `setRepoList`, the journal-then-broadcast ordering) is
untested. `ctx.forestRoot` in particular is a string wired across two files with
nothing asserting they agree. This is where a future refactor breaks silently.

**The in-memory list cannot re-sync after an out-of-band edit** — if
`repos.json` gains an entry while the server runs, `ctx.repoList` stays stale and
adding the same path through the form returns `already-listed` (compared against
the file), a dead end until restart. Returning `repos` alongside the
`already-listed` reason and having the route call `ctx.setRepoList` would make
the error self-healing.

**`ctx.getRepoList` is dead code** — `server.mjs:84`, no consumers. Drop it or
document why it is part of the ctx contract.

## Fine to leave

- **A scan-deduped listed entry has no ✕.** Adding a repo the scan already finds
  leaves a permanent, invisible entry in `repos.json`. Deliberate — the repo
  renders correctly from the scan's own card, and the entry self-heals into a
  removable group the moment the scan stops finding that path.
- **`writeRepoList` has no temp-file+rename**, and **`gitToplevel`'s `execFile`
  has no timeout** — both match existing convention (`lib/packs.mjs`,
  `lib/git.mjs`); changing one without the others buys nothing.
- **Torn-read-as-malformed** — `writeFile` is not atomic and `readRepoList` is
  lock-free, so a concurrent reader could in principle see a truncated file. The
  only lock-free read runs at startup before `server.listen`, so no write can be
  in flight; the crash-mid-write durability angle survives and is acceptable for
  a single-user local tool.
- **The oplock namespace is shared with `finish.mjs`** — `repos.mjs` keys on
  `forestRoot` (which carries a trailing slash) and `finish.mjs` on `join()`-built
  repo paths (which never do), so they cannot collide. Incidental rather than
  designed; one comment would make it deliberate.
- **Journal logs the raw pre-expansion path** (`repo added: ~/foo` while the file
  stores the absolute form), `warnedRepos.clear()` fires on a no-op remove, and a
  benign journal-ordering race can print a stale `skipped` line just after a
  `removed` line. All cosmetic.
- **`removeRepo(root, undefined)` returns `{ ok: true }`** — only reachable by a
  direct POST; the UI always sends a path.
- **Duplicates *within* `repos.json`** are reported twice in `skippedRepos`, and
  two entries resolving to one real path collapse silently. Only reachable by
  hand-editing the file, which `addRepo` prevents.
- **Assorted test-shape nits** — `readKitManifest`-style partial coverage of
  override keys, conflict tests not asserting `copied === 0`.

## Closed by measurement or verification

- **The concurrency test discriminates.** N=5 (the plan's suggestion) did not
  interleave on this machine; failure rates were measured at 5→0/25, 10→4/10,
  15→9/10, 20→10/10, and N=20 was chosen. With the lock in place the result is
  deterministic regardless of machine speed, because `withOpLock`'s queue is a
  synchronous JS chain — so the test is slow (~1.2s, 20 `git init` calls) but not
  flaky.
- **The security posture does not widen.** `execFile` with an argv array (no
  shell), `isAbsolute` prevents a `-`-prefixed argument reaching `git -C`, and
  these routes' capability is strictly dominated by `/api/task`, which already
  runs an arbitrary prompt on the same localhost-bound server. The one new
  property is persistence: an added path keeps being polled every four seconds
  across restarts.

## Known flake

`lib/finish.test.mjs:148` hit a git `index.lock` race once during this work and
did not reproduce. Pre-existing, unrelated to this feature, worth watching.

## Process notes for the next plan

**Two documents defined "a git repo" two different ways and never sat side by
side.** The spec chose `rev-parse --git-dir` for validation and argued for it;
the plan supplied `.git`-exists as literal code for discovery. Both were
implemented faithfully, five task reviews passed, and only the whole-branch
review — the first reader to see both at once — caught it. When a plan defines
the same concept in two places, say so explicitly and name the shared helper.

**A subagent killed the user's live server** with `pkill -f "node server.mjs"`,
a pattern that matched an instance it did not start. Briefs now say: stop
processes by PID only.

**The plan staged `style.css` in a commit while specifying CSS for only one of
the three new selectors.** The implementer wrote exactly what was given. If a
plan hands over new class or id hooks, it owns their styling too.
