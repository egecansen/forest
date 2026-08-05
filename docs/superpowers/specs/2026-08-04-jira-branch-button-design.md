# "Branch → Jira" button in the worktree drawer

Status: approved 2026-08-04 (user: "go"). Trigger scope: button only — no
auto-submit on worktree create.

## Purpose

Sahibinden tickets carry a "Git Branch Name" text field (`customfield_10041`
on jira.sahibinden.com) that should hold the ticket's dedicated branch name.
Forest's drawer already knows both halves — the worktree's branch
(`tech/WEBT-226230`) and the re-keyed ticket (`SHBDN-226230`, via
`jiraKey()`) — so a button in the drawer submits the branch name to the
ticket's field on click.

## Config

New key `jiraBranchFieldId`, default `''`, in `DEFAULTS`
(env: `FOREST_JIRA_BRANCH_FIELD`) and `config.example.json`. The field ID is
org-specific, so it lives in config, never in code. Empty ⇒ the button never
renders. Not a secret: the client sees it via `/api/config` and uses it to
gate button visibility.

## Jira layer — `lib/jira.mjs`

`submitBranchField(key, branch, { baseUrl, token, email, fieldId, force,
fetchImpl = fetch, timeoutMs = 5000 })`, following `fetchSummary`'s
conventions exactly: injectable fetch, `AbortSignal.timeout`, never throws,
error strings are actionable sentences shown verbatim in the drawer.

Read before write:

1. GET `/rest/api/2/issue/<key>?fields=<fieldId>` — read current value.
2. Current value already equals `branch` → `{ ok: true, already: true }`, no
   write.
3. Different non-empty current value and not `force` →
   `{ conflict: <current> }`, no write. (Decision: read-before-write over
   blind PUT — one extra GET buys never silently clobbering a value someone
   else set.)
4. Otherwise PUT `/rest/api/2/issue/<key>` with
   `{ fields: { [fieldId]: branch } }` → `{ ok: true }`.

Missing `baseUrl` / `token` / `fieldId` / `key` / `branch` → `{ error }`
sentences naming the fix, mirroring `fetchSummary`.

## Endpoint — `lib/actions.mjs`

`POST /api/jira/submit-branch`, body `{ path, force }`:

- `findWorktree` on the cached snapshot; unknown → 404.
- No branch or no ticket on the worktree → 400 with a sentence.
- Re-key via `jiraKey(w.ticket, config.jiraProjectKey)`; submit the **full
  branch name**.
- Journal the action (`jira: set Git Branch Name on <key> → <branch>`), like
  every other mutation.
- The submit function is injectable into `createActionHandler` (like
  `launch`), so the route tests run without a Jira.

## UI — `public/app.js`

Button in the description panel's action row (next to Edit), rendered only
when the description payload has a `ticket` and
`state.config.jiraBranchFieldId` is non-empty. Tooltip names exactly what
will be written where. Click → POST; `{ conflict }` → browser `confirm`
("Git Branch Name already holds X — overwrite?") → retry with
`force: true`; success → toast "Git Branch Name set on <key>"; `already` →
toast "already set"; `{ error }` → surfaced the way the description panel
surfaces `jiraError` today.

## Tests

- `lib/jira.test.mjs`: URL/method/payload/auth shape of both calls;
  already-equal short-circuit; conflict without force; force overwrites;
  401/403, 404, timeout, network error; unconfigured baseUrl/token/fieldId.
- `lib/actions.test.mjs`: unknown worktree; worktree without ticket; field
  ID unconfigured; happy path passes the re-keyed key + full branch name to
  the injected stub and journals.

## Out of scope

Auto-submit on `/api/worktree/create` (explicitly declined), transitions,
comments, any other Jira field.

---

# Phase 2 (approved 2026-08-04): empty-field highlight + priority colors

## A. Empty Git Branch Name highlight — drawer only

When the drawer renders the Branch → Jira button, the client asks
`POST /api/jira/branch-field` `{ path }` → `{ ok, key, value }` what the
ticket's field holds. Empty value → the button gains class `attn` (small
amber dot via `::after`, no layout shift) and its tooltip becomes
"<key>'s Git Branch Name is empty — click to fill it". Jira unreachable →
no highlight, silently. A successful submit removes the highlight.

Server side: `readBranchField(key, { baseUrl, token, email, fieldId,
fetchImpl, timeoutMs })` → `{ value: string|null } | { error }` extracted
from `submitBranchField`'s read half; `submitBranchField` refactors onto it
(existing tests must stay green). Trimmed; empty/whitespace → `null`.

## B. Priority colors on worktrees — manual labels

Four colors, meaning entirely the user's: `red` (var(--danger)), `amber`
(var(--amber)), `green` (var(--green)), `blue` (var(--run)) — theme-aware.

- **Store** `lib/priorities.mjs`: mirrors descriptions.mjs exactly (per-repo
  `.forest/priorities.json`, atomic write, per-repo lock, keyed by
  `priorityKey(worktree) = branch || path`).
- **Snapshot**: `buildSnapshot` reads the repo's priorities once per repo
  and stamps `priority: color|null` on each worktree record — the deck
  needs no extra requests.
- **Route** `POST /api/worktree/priority` `{ path, priority }`: validates
  the color (`''`/null clears), 404 unknown worktree, 400 bad color, saves,
  broadcasts a fresh snapshot. Not journalled (mirrors description/save).
- **Deck row**: colored dot before the branch name (`.prio-dot`, a real
  span — the `::before/::after` slots on `.col-branch` are taken by the
  tree connectors) plus a 3px inset left stripe on the row
  (`box-shadow: inset 3px 0 0 <color>`, no layout shift). Both were
  explicitly requested to be visible on the deck.
- **Drawer**: a swatch row under the title — four color dots + ✕ clear,
  current selection ringed. Click saves, updates the local snapshot copy
  and re-renders immediately; SSE confirms within one refresh.
