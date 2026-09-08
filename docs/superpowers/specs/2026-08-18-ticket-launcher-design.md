# Ticket launcher — Jira sprint/backlog picker + SRP boxes + one seeded session

**Date:** 2026-08-18
**Repos affected:** `APPS/forest` only. Consumes `SKLS/hektor`'s
`hektor-multi-ticket` / `hektor-from-jira` skills but changes neither.
**Status:** DESIGNED — not implemented.

## Problem

Starting a multi-ticket run today is entirely manual. The user reads their
sprint in a Jira tab, copies ticket keys by hand, remembers which testboxes
they hold in an SRP tab, opens a terminal in the right checkout, starts
`claude`, and types the tickets and boxes into the first message. Forest
already owns the last two steps (it launches the session and provisions the
skills) and already talks to Jira — but only about *one* ticket, the one
implied by a branch that already exists (`lib/jira.mjs`).

Three costs follow:

1. **The ticket list is retyped.** Keys are 6 digits; a typo produces a
   worktree named after a ticket that does not exist, discovered a phase later.
2. **The box list is remembered, not read.** `hektor-multi-ticket` refuses to
   run without `boxes:` and cannot verify what it is given. A box the user no
   longer holds fails at the first `gradle test`, after the authoring work.
3. **The session starts empty.** Forest launches bare `claude`; the intent
   ("these five tickets, these two boxes") is typed again into a fresh
   session that has no idea why it was opened.

## Decision

A repo-scoped **Tickets modal**: pick a person, pick tickets from their current
sprint or their backlog, pick from the testboxes they actually hold in SRP
(reserving one from inside forest if they hold none), then launch **one**
Claude session in that repo's primary checkout, seeded with a prompt naming the
tickets and boxes. `hektor-multi-ticket` does the fan-out from there.

Forest does not create per-ticket worktrees. The skill's Phase 1 already
provisions one worktree per ticket through the pack's
`worktree-provision.sh` — the only path that carries `.claude/`, `CLAUDE.md`
and the gates into a new tree. Duplicating that in forest would mean two
owners of provisioning and a Phase 1 that has to be told to stand down. The
worktrees it creates show up as ordinary forest rows on the next snapshot.

## Non-goals

- **No board model.** SHBDN has 83 boards; `sprint in openSprints()` filtered
  by assignee answers "their current sprint" without asking which board.
- **No release of shared resources.** Forest reads SRP reservations and can
  create one. It never revokes, cancels or extends — freeing someone's box by
  misclick mid-run costs more than the convenience is worth.
- **No new provisioning path** (see Decision).
- **No Jira writes.** This feature only reads. The existing Branch → Jira
  button remains the one place forest writes to Jira.

## Surface — the Tickets modal

`tickets` joins `+ worktree` / `prune` in each repo-group header, so the modal
is bound to a repo from the moment it opens and the session starts in that
repo's primary checkout.

```
Tickets — web-test                              [ Egecan Sen ▾ ]  ↻
  ( Sprint 12 )  ( Backlog 43 )            [ filter… ]
  ☑ SHBDN-253990  In Progress   CI - İlan detay Endeks Kozmetik Düzenlemeler
  ☑ SHBDN-254664  In Progress   CI - Toplu Doping Sayfaları Metin Revizeleri
  ☐ SHBDN-252620  Selected      WEBT - Localization Preprod da çalıştırılması
  …
  Boxes (SRP)  ☑ x:161  6h left · "WEBT triage"   ☑ x:230  2d left · "---"
  ┌ prompt ─────────────────────────────────────────────────────────┐
  │ Hektor, multi-ticket: SHBDN-253990, SHBDN-254664                │
  │ boxes: x:161, x:230                                             │
  │ waves of 3, base origin/master                                  │
  └─────────────────────────────────────────────────────────────────┘
  2 tickets · 2 boxes · skills: last selection (22)  Cancel  [ Start multi-ticket session ]
```

Rules the surface enforces:

- **Sprint and Backlog are two tabs over two JQLs**, never merged — "current
  sprint" has to keep meaning the active-sprint set.
- **Person** opens on the last person picked (localStorage
  `forest-jira-person`), falling back to `currentUser()` on first use. Typing
  searches Jira users; recent picks stay in the list.
- **Start is disabled** with the reason inline until at least one ticket *and*
  one box are selected. The skill stops and asks for boxes otherwise, which
  wastes a session start.
- **One ticket selected** switches the button to *Start ticket session* and
  seeds `hektor-from-jira` — `hektor-multi-ticket` says it adds nothing for a
  single ticket.
- **The prompt is shown and editable** before launch. It is the last line of
  defence for every guess this feature makes (box label, wave size, base).
- **Skills are not re-chosen here.** The launch reuses that repo's last picker
  selection (`forest-skills:<path>`), named in the footer with a link that
  opens the skill picker for a change.

## Jira side — `lib/jira-search.mjs`

A second module beside `jira.mjs`, which stays about one ticket. Same contract
as its neighbour: nothing throws, every failure is a sentence the modal prints
verbatim, and `fetchImpl` is injected so the whole module tests without a Jira.

```js
sprintJql(user)  // assignee = "<user>" AND sprint in openSprints()
                 //   AND statusCategory != Done ORDER BY rank
backlogJql(user) // assignee = "<user>" AND (sprint is EMPTY OR sprint not in openSprints())
                 //   AND statusCategory != Done ORDER BY updated DESC
searchIssues(jql, opts) // -> { issues: [{key, summary, status, type, priority, updated}],
                        //      total, truncated } | { error }
searchUsers(q, opts)    // -> { people: [{name, displayName}] } | { error }
me(opts)                // -> { name, displayName } | { error }
```

`fields=summary,status,issuetype,priority,assignee,updated`, `maxResults=100`.
`truncated` is `total > issues.length` and renders as a line in the modal — a
silently capped list reads as "that's all of it".

Keys come back already in the project the issues live in (`SHBDN-…`), which is
what the skills want. No `jiraKey()` re-keying on this path; that helper exists
for the opposite direction, branch → issue.

Routes in `lib/actions.mjs`, following the POST-with-body shape of its
neighbours:

- `POST /api/jira/tickets {scope: 'sprint'|'backlog', assignee, refresh?}`
- `POST /api/jira/people {q}` — empty `q` returns `me()` only.

Successful ticket lists memoise for 60s per (scope, person); ↻ and `refresh`
bypass it. Errors are not cached: fixing a token in `config.json` must take
effect on the next click, not a minute later.

## SRP side — `lib/srp.mjs`

SRP (`https://srp.ngntest.sahibindenlocal.net`) is a Vue SPA over a JSON API
with the envelope `{data, error: {code, message}}` and the header
`S-Access-Token`. Endpoints this feature uses:

| Purpose | Call |
|---|---|
| My reservations | `GET /api/reservation/v1/records?username&status&page&pageSize` → `data.records`, `data.numberOfRecords` |
| Reserve | `POST /api/reservation/v1/records {description, expectedEndDate, status:"OK", expectedState, username}` |
| Mint access token | `POST /api/identification/v1/auth/refresh {refreshToken}` → `accessToken` (at the root or under `data`) |

A record carries `testbox, status, description, startDate, endDate,
expectedEndDate, expectedState, infraChanges, username, connectionCommand`.
`status: "OK"` is an active reservation. `expectedState` is SRP's 1–5 enum
(1 Off, 2 On, 3 Data Updated, 4 Data Inserted, 5 Data Sane).

**Auth.** `config.srpRefreshToken` (pasted once from SRP's localStorage) is
exchanged for an access token held in memory for the server's lifetime,
re-minted once on a 401 and then given up on with a sentence telling the user
to paste a fresh one. The refresh token joins `jiraToken` in `SECRET_KEYS` so
`/api/config` never serves it. LDAP user+password is deliberately not an
option: a plaintext password in `config.json` is a worse trade than a
re-pasteable token.

**Username** comes from the access token's JWT payload — first of `username`,
`sub`, `name` that is a non-empty string — with `config.srpUsername` as an
override. Decoding is payload-only base64url; forest never validates the
signature, which is the server's job.

**`boxLabel(record)`** normalises a record to the `dc:id` form the skills want:

| `record.testbox` | → |
|---|---|
| `x:161` (already `^[a-z]+:\d+$`) | `x:161` |
| `x161`, `x-161`, `x_161`, `x 161` | `x:161` |
| anything else | verbatim, uncorrected |

The last row is the honest case: no authenticated record was available when
this was written, so an unrecognised shape passes through to the editable
prompt rather than being mangled into a plausible-looking wrong box. The first
real record either confirms the table or replaces it — a one-line fixture
change.

**Reserve** posts with `description` prefilled from the selected ticket keys
(SRP's own field for "what is this box for"), `expectedEndDate` defaulting to
18:00 today, `expectedState: 5` (Data Sane). HTTP 441/442 are *queued*, not
failed — they render as "queued, waiting for a box" and forest re-polls the
records list. Reserving happens only on an explicit click; nothing about
opening the modal creates a reservation.

Routes: `POST /api/srp/boxes {refresh?}` and `POST /api/srp/reserve {description,
expectedEndDate, expectedState}`.

**Degradation.** No `srpRefreshToken`, an unreachable host (off-VPN), or any
SRP error falls back to `config.testboxes` as a plain checkbox list, with the
reason shown. The Jira half of the modal keeps working — a box list is not
worth breaking a ticket picker over.

## Launch — one seeded session

`POST /api/launch` gains an optional `prompt`. `launchClaudeSession()` gains
the same parameter and runs `claude <shQuote(prompt)>` instead of bare
`claude`; everything else about the launch path — gates, orphan check,
provision record, journal line — is untouched.

`composeTicketPrompt({tickets, boxes})` lives in `public/prompt.js` as plain
ESM so the browser imports it for the preview and a node test imports the same
file. It has no DOM references for exactly that reason.

```
N ≥ 2   Hektor, multi-ticket: SHBDN-253990, SHBDN-254664
        boxes: x:161, x:230
        waves of 3, base origin/master

N = 1   Hektor, work SHBDN-253990 — box x:161
```

**The edge that matters:** forest allows one session per worktree, and today an
already-alive session is silently focused. With a prompt attached that would
look like a launch that dropped the ticket list. The response therefore carries
`promptSent: false` when it focused an existing session, and the modal says
*"session already running in web-test — ticket list not sent"* and offers the
prompt for copy-paste.

## Code layout

`public/app.js` is already 1150 lines and owns every modal in the app. The
ticket modal is ~200 more, so it goes in its own ES module — `public/tickets.js`,
imported by `app.js`, which is already `<script type="module">`. It exports
`openTickets(repoPath)` and takes its dependencies (`api`, `toast`, `esc`,
`state`) as arguments rather than reaching back into `app.js`, so the seam
stays one-way. The modal's markup joins the others in `index.html`;
`public/prompt.js` stays separate from both because a node test imports it.

## Config

```jsonc
{
  "testboxes": ["x:161", "x:230"],   // fallback only, used when SRP is unavailable
  "srpBaseUrl": "https://srp.ngntest.sahibindenlocal.net/api",
  "srpRefreshToken": "…",            // secret — stripped from /api/config
  "srpUsername": ""                  // optional override; normally read from the token
}
```

Each gets a `FOREST_*` env equivalent in `DEFAULTS`, matching every existing
key. `srpRefreshToken` is added to `SECRET_KEYS`.

## Failure modes

| Situation | What the user sees |
|---|---|
| No `jiraBaseUrl` / `jiraToken` | "set jiraToken (or FOREST_JIRA_TOKEN) to list tickets" — same voice as `jira.mjs` |
| Jira 401/403 | "Jira rejected the credentials (401)" |
| Jira timeout | "Jira request timed out" — the modal stays open with the last list |
| Person has no sprint issues | "no tickets in the current sprint for Egecan Sen" |
| More than 100 matches | list plus "showing 100 of N" |
| No `srpRefreshToken` | box row falls back to `config.testboxes`, labelled "SRP not configured" |
| SRP unreachable (off VPN) | same fallback, labelled "SRP unreachable" |
| SRP 401 after one re-mint | "SRP rejected the token — paste a fresh srpRefreshToken" |
| Reserve returns 441/442 | "queued, waiting for a box" + re-poll |
| No boxes at all | Start stays disabled: "pick at least one testbox" |
| Session already alive in repo | "session already running — ticket list not sent", prompt offered for copy |

## Testing

- `lib/jira-search.test.mjs` — exact JQL strings for both scopes, field
  mapping, `truncated`, 401/404/timeout → sentences, cache hit/expiry/bypass,
  user-search shape. Injected `fetchImpl`; no network.
- `lib/srp.test.mjs` — token mint, reuse, single re-mint on 401 then give up;
  username from JWT payload and the config override; record mapping;
  `boxLabel` table above; reserve 2xx / 441 / 442 / 500; every
  missing-config sentence.
- `lib/actions.test.mjs` — the four new routes; `/api/launch` with a prompt
  produces the quoted `claude '<prompt>'` command; an alive session returns
  `promptSent: false`.
- `public/prompt.test.mjs` — 1-vs-N wording, box joining, key ordering.
- Manual, in the browser: modal open → person switch → tab switch → select →
  launch, against the real Jira, mirroring how the picker work was verified.

## Build order

1. `lib/jira-search.mjs` + routes + tests.
2. `/api/launch` prompt plumbing + `public/prompt.js` + tests.
3. Tickets modal against `config.testboxes` — usable end-to-end at this point.
4. `lib/srp.mjs` + routes + tests.
5. Box row switches to SRP reservations, with reserve-inline and the fallback.

Each step leaves forest working; a stall at 3 still ships the feature minus
live box data.

## Appendix — what was verified, 2026-08-18

Read-only probes from this machine:

- `GET /rest/api/2/myself` → `egecan.sen` / "Egecan Sen" (Jira Server PAT,
  `Bearer`).
- Sprint JQL → 12 issues; backlog JQL → 43 issues.
- `GET /rest/api/2/user/search?username=sen` → 5 users, `{name, displayName,
  active}`.
- `GET /rest/agile/1.0/board?projectKeyOrId=SHBDN` → 83 boards (why the design
  is board-agnostic).
- SRP `GET /api/reservation/v1/records`, `/api/pool-manager/v1/testboxes`,
  `/api/identification/v1/users` → all `401 {"data":null,"error":{"code":401,
  "message":"Invalid token"}}`, confirming reachability and envelope.
- SRP endpoint paths, request bodies, the `S-Access-Token` header, the refresh
  flow and the 441/442 queue codes were read out of the published SPA bundle
  (`/assets/index-DhqpzKwW.js` and its `Overview` / `Reservations` chunks).
