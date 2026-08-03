# Worktree description — design spec

**Date:** 2026-08-03
**Repos affected:** `APPS/forest`
**Status:** approved by Egecan, pending implementation

## Problem

The drawer tells you what a worktree *is* — repo, owner, age, size, diff — but
never what it is *for*. `tech/WEBT-229553` is a branch name, not a reason. A week
later the only way to recover the intent is to open Jira and search for the
number by hand.

The ticket key is already parsed (`extractTicket`, `lib/git.mjs:53`) and
`jiraBaseUrl` already exists in config, but the pair is used for exactly one
thing: turning the branch cell into a link. Nothing carries the ticket's *title*,
and nothing lets you write down anything the ticket does not say.

## Decisions

Settled during brainstorming (2026-08-03):

- **Auto-filled, but never authoritative.** Forest composes a description from
  the ticket. The user can overwrite it, and once overwritten Forest never
  argues.
- **Only overrides are stored.** The generated text is never persisted, so it
  cannot go stale and there is no cache to invalidate.
- **Jira is optional infrastructure.** Every failure path — no token, no base
  URL, 401, 404, offline, timeout — degrades to the link-only description with a
  one-line reason. A description box must never be blocked on a network call.
- **Fetch lazily, never in the snapshot loop.** The 4-second snapshot walks
  every worktree in every repo; fetching there is dozens of Jira requests every
  four seconds, forever.
- **No hardcoded company specifics.** The project-key rewrite is a config key,
  not a constant. Forest stays cloneable, per the README's portability claim.

## Ticket resolution — `lib/jira.mjs` (new)

Pure functions plus one network call with an injectable `fetch`.

```
branch  tech/WEBT-229553
  → extractTicket()            WEBT-229553      (exists, lib/git.mjs:53)
  → jiraKey(t, projectKey)     SHBDN-229553     (number re-keyed onto projectKey)
  → browseUrl(base, key)       https://jira.sahibinden.com/browse/SHBDN-229553
  → fetchSummary(key, …)       { summary } | { error }
  → composeDescription(…)      the two-line block
```

`jiraKey(ticket, projectKey)` takes the trailing `-\d+` off the branch's ticket
and re-keys it onto `projectKey`. With `projectKey` empty (the default) the
ticket passes through unchanged, which is what any repo that is not sahibinden's
wants. Egecan's branches are prefixed `WEBT`/`SUI`/`QUICKLY` by convention while
the real Jira project is `SHBDN`, so his `config.json` sets
`jiraProjectKey: "SHBDN"`.

`fetchSummary` issues `GET {base}/rest/api/2/issue/{KEY}?fields=summary` with a
5-second `AbortSignal.timeout`. Auth is `Bearer {jiraToken}`, or Basic
`{jiraEmail}:{jiraToken}` when an email is configured (Jira Cloud). It returns
`{ error }` rather than throwing, with a message that names the cause:

| Condition | `error` |
|---|---|
| `jiraBaseUrl` unset | `set jiraBaseUrl in config.json to fetch titles` |
| `jiraToken` unset | `set jiraToken (or FOREST_JIRA_TOKEN) to fetch titles` |
| 401 / 403 | `Jira rejected the credentials (401)` |
| 404 | `SHBDN-229553 not found in Jira` |
| other status | `Jira returned 500` |
| abort | `Jira request timed out` |
| network throw | the thrown message |

`composeDescription({ summary, url })` joins what exists: title line, then URL
line. No summary → the URL alone. No URL → the empty string (a non-ticket branch
still gets an editable, initially empty box).

Summaries are memoised per key in a `Map` held by the action handler's closure,
so opening the same drawer repeatedly costs one request per server lifetime.
Failures are cached too, and re-fetched at most once per minute — a Jira that is
down must not be retried on every drawer open, but a token fixed in config
shouldn't need a server restart either.

## Override store — `lib/descriptions.mjs` (new)

A direct sibling of `lib/landed.mjs`: `<repoPath>/.forest/descriptions.json`,
atomic temp-file-plus-rename write, per-repo in-process promise chain so
concurrent saves cannot interleave their read-modify-write.

```js
readDescriptions(repoPath)            // -> {}          (missing/corrupt -> {})
readDescription(repoPath, key)        // -> string|null
saveDescription(repoPath, key, text)  // locked RMW
clearDescription(repoPath, key)       // locked RMW, deletes the key
```

**Keyed by branch, not by path.** A description belongs to the work, not to the
directory: it survives `worktree remove` plus re-creation, and it survives the
finish flow moving a branch into the main checkout. Detached worktrees have no
branch and fall back to the worktree path as the key.

Saving `""` stores an empty override — a deliberate blank is a valid answer, and
"Reset to auto" is how you get the generated text back.

## API

Three POSTs in `lib/actions.mjs`. Read-only POST already has precedent there
(`/api/worktree/scope`, `/api/repo/prune-preview`), and it keeps the worktree
lookup, config and summary cache in one place.

| Route | Body | Returns |
|---|---|---|
| `/api/description` | `{ path }` | `{ text, override, ticket, url, jiraError? }` |
| `/api/description/save` | `{ path, text }` | `{ ok: true }` |
| `/api/description/reset` | `{ path }` | `{ ok: true, text, ticket, url, jiraError? }` |

All three resolve `path` against `ctx.cachedSnapshot()` to recover `repoPath` and
`branch`; an unknown path is a 404 `{ error: 'unknown worktree' }`.

`/api/description` returns the override when one exists and never touches the
network in that case. Reset deletes the override and returns the freshly
generated text, so the textarea can be repopulated without a second round trip.

## Config

Three new keys, all defaulting to `""` (feature off, no behaviour change for any
existing install):

| Key | Env | Meaning |
|---|---|---|
| `jiraProjectKey` | `FOREST_JIRA_PROJECT_KEY` | rewrites the branch's ticket key |
| `jiraToken` | `FOREST_JIRA_TOKEN` | PAT for the summary fetch |
| `jiraEmail` | `FOREST_JIRA_EMAIL` | present ⇒ Basic auth (Jira Cloud) |

Precedence is the same as every other key and worth stating because it is the
opposite of what people assume: `mergeConfig` is `{ ...DEFAULTS, ...user }`, the
env var only supplies the *default*, and **`config.json` overrides it**. A key
present in `config.json` with an empty string therefore defeats its env var
silently. Either set the value in `config.json` or omit the key entirely — do
not leave it blank and expect the environment to fill it in.

**`server.mjs` currently serves the whole config object to the browser**
(`/api/config`, line 116). `jiraToken` must be stripped from that response. It is
a credential, and the dashboard has no use for it.

## UI

A `Description` section in the drawer, between the meta line and `Diff`
(`public/app.js:256`). It has two states, because opening a drawer is usually
for reading, not writing.

**Reading — the default:**

```
tech/WEBT-229553
web-test · user · today · —

▾ DESCRIPTION
CI - Ödeme Sayfası Kart ile Öde Componenti Dil Desteği - Arama
https://jira.sahibinden.com/browse/SHBDN-229553      ← clickable
[ Edit ]                                    from the ticket

DIFF
```

**Editing — entered by Edit, left by Save or Cancel:**

```
▾ DESCRIPTION
┌──────────────────────────────────────────────────┐
│ …                                                │  ← grows to fit
└──────────────────────────────────────────────────┘
[ Save ]  Cancel  Reset to auto                  edited
```

- The read view renders text with bare URLs turned into links. `linkify` splits
  on a capturing regex and escapes every part exactly once, so no user text ever
  reaches the DOM unescaped.
- The textarea auto-sizes to its content (`resize: none`, `overflow: hidden`,
  height set from `scrollHeight`), so a one-line description is one line tall.
- **Save** persists (Cmd/Ctrl+Enter also saves) and returns to reading.
  **Cancel** and Escape leave without saving — Escape `stopPropagation()`s so it
  does not close the whole drawer and discard what was typed.
- **Reset to auto** shows only while editing an override.
- The heading is the collapse control; the state is one global preference in
  `localStorage` (`forest-desc-collapsed`), applied before the fetch resolves so
  a collapsed section never flashes open.
- A `jiraError` renders as one muted line under the controls. It explains, it
  does not block.

**Branch cells stop linking to Jira.** `ticketCell` became `branchCell` and
renders plain text. A branch name that navigated away made the widest click
target in the row the one that left the app, and every row's real action —
open the drawer — was the thing it interrupted. The ticket link now lives in the
description, where it is asked for rather than hit by accident.

## Testing

`node --test`, no new dependencies.

`lib/jira.test.mjs`
- `jiraKey`: rewrite, pass-through when `projectKey` is empty, `null` ticket,
  a ticket with no trailing number.
- `browseUrl`: trailing-slash base, missing base, missing key.
- `composeDescription`: both parts, URL only, neither.
- `fetchSummary` against a stub `fetchImpl`: 200 shape, 401, 404, 500, a thrown
  network error, an abort, and the two unconfigured guards. The stub also
  asserts the request URL and `Authorization` header, including the Basic
  variant.

`lib/descriptions.test.mjs`
- Round-trip save → read in a `mkdtemp` repo.
- Missing file and corrupt JSON both read as `{}`.
- `clearDescription` removes one key and leaves its siblings.
- Concurrent `saveDescription` calls on one repo: all writes survive (the lock
  works), asserted by firing N saves without awaiting between them.
