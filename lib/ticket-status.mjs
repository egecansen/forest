import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jiraKey } from './jira.mjs';

// The only values a brief's `Status:` line is allowed to mean. Anything else
// — a typo, a half-finished edit, an agent going off-script — reads as no
// status at all rather than being shown verbatim: a mangled file must not be
// able to put arbitrary text on the dashboard.
export const TICKET_STATUSES = ['not started', 'in progress', 'blocked', 'ready for review'];

// Case-insensitive on both the label and the value; matches the first
// `Status:` line found anywhere in the file. writeTicketBrief() (lib/actions.mjs)
// always writes exactly one, under a `## Progress` heading, so "first" and
// "only" coincide in practice.
export function parseTicketStatus(text) {
  const m = String(text ?? '').match(/^Status:\s*(.+?)\s*$/mi);
  if (!m) return null;
  const val = m[1].trim().toLowerCase();
  return TICKET_STATUSES.includes(val) ? val : null;
}

function briefPath(worktreePath, fileKey) {
  return join(worktreePath, 'docs', 'hektor', 'tickets', `${fileKey}.md`);
}

// stat, then (on a cache miss by mtime) read+parse one candidate brief path.
// Returns { found, result }: `found` is true the moment stat succeeds — even
// if the content doesn't parse — so the caller knows not to try another
// filename; `result` is the `{ key, status } | null` payload once resolved.
async function lookupBrief(path, resultKey, cache, statImpl, readFileImpl) {
  let st;
  try {
    st = await statImpl(path);
  } catch {
    cache.delete(path); // brief existed once, then vanished — drop any stale entry
    return { found: false, result: null };
  }

  const cached = cache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    return { found: true, result: cached.status ? { key: resultKey, status: cached.status } : null };
  }

  let text;
  try {
    text = await readFileImpl(path, 'utf8');
  } catch {
    cache.set(path, { mtimeMs: st.mtimeMs, status: null });
    return { found: true, result: null };
  }

  const status = parseTicketStatus(text);
  cache.set(path, { mtimeMs: st.mtimeMs, status });
  return { found: true, result: status ? { key: resultKey, status } : null };
}

// Reads the `Status:` line from a worktree's own ticket brief, if it has one.
//
// Which brief, and the branch-prefix/Jira-key split: the ticket briefs the
// tickets flow writes (writeTicketBrief in lib/actions.mjs) are named after
// the real Jira key — e.g. `docs/hektor/tickets/SHBDN-241011.md` — while the
// worktree's own branch carries a team prefix instead of the project key
// (`tech/WEBT-241011`), because branch naming and the Jira project are
// independently configured (see jiraKey() in lib/jira.mjs, and how
// lib/actions.mjs already re-keys with it before touching Jira). `ticket`
// here is the one already extracted from the branch (git.mjs's
// extractTicket, which discover.mjs computes once per worktree for its
// `ticket` field and passes straight through — never redone here), so this
// function re-keys it onto `projectKey` the same way before building a path.
//
// Both namings can legitimately exist on disk — an install that never
// configured `jiraProjectKey` writes and reads the raw ticket name; one that
// did will have re-keyed briefs going forward but may still hold older
// raw-named ones. So: try the re-keyed name first, and only on a miss (the
// file is not there at all — not merely unparseable) fall back to the raw
// branch ticket. When `projectKey` is empty or the ticket has no trailing
// number to re-key, jiraKey() returns the ticket unchanged and there is only
// one name to try — the common case stays a single stat either way.
//
// forest never lists `docs/hektor/tickets/` looking for candidates; it only
// ever tries these (at most two) exact, predictable paths. A brief for some
// other ticket sitting in the same directory (a leftover from a rebase, a
// stray copy) is never looked at. If neither exact name exists, or the
// worktree's branch carries no ticket at all, the result is null — same as
// "no brief".
//
// Cost: `cache` is a Map the caller owns and keeps alive across calls (the
// same shape as the `sizes` Map server.mjs threads through buildSnapshot) —
// this module holds no state of its own, so nothing leaks between tests or
// server restarts. A worktree with no ticket costs nothing (no I/O at all).
// The common case — re-keyed brief present, or the two names coincide —
// costs one stat(); only a worktree relying on the fallback name pays a
// second stat, every tick, for as long as no re-keyed brief exists for it.
// stat() is an in-process syscall, not a subprocess spawn like the `du`
// behind sizeBytes, which is why this is cheap enough to sit on the periodic
// snapshot loop rather than needing to be computed on demand elsewhere.
// Absence itself is never cached — every call re-stats — so a brief that
// shows up after previously being missing is picked up on the very next
// call, not stuck null until a restart. The expensive step (readFile +
// regex) only runs when a brief exists AND its mtime has changed since the
// last look; both a successful parse and a "file's here but has no valid
// Status: line" result are cached by mtime, so an unchanged-but-unparseable
// brief is not re-read every tick either.
export async function readTicketStatus(worktreePath, ticket, cache, { projectKey = '', statImpl = stat, readFileImpl = readFile } = {}) {
  if (!ticket) return null;

  const reKeyed = jiraKey(ticket, projectKey) || ticket;
  const primary = await lookupBrief(briefPath(worktreePath, reKeyed), ticket, cache, statImpl, readFileImpl);
  if (primary.found) return primary.result;
  if (reKeyed === ticket) return null; // nothing else to try — same name either way

  const fallback = await lookupBrief(briefPath(worktreePath, ticket), ticket, cache, statImpl, readFileImpl);
  return fallback.result;
}
