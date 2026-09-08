// lib/jira-search.mjs — listing a person's tickets, not resolving one branch's
//
// The sibling of jira.mjs: same nothing-throws contract, same injected fetch,
// but it answers "what is this person working on" instead of "what is this
// ticket called". Board-agnostic on purpose — SHBDN has 83 boards, and
// openSprints() filtered by assignee answers "their current sprint" without
// forest having to know which board that is.

import { authHeader } from './jira.mjs';

const trimSlashes = (s) => String(s ?? '').replace(/\/+$/, '');
const FIELDS = 'summary,status,issuetype,priority,assignee,updated';

// JQL string literals: a quote or backslash in a username would otherwise end
// the literal early and hand Jira a query we did not write.
const quote = (s) => `"${String(s ?? '').replace(/["\\]/g, '\\$&')}"`;

export const sprintJql = (user) =>
  `assignee = ${quote(user)} AND sprint in openSprints() AND statusCategory != Done ORDER BY rank`;

export const backlogJql = (user) =>
  `assignee = ${quote(user)} AND (sprint is EMPTY OR sprint not in openSprints()) AND statusCategory != Done ORDER BY updated DESC`;

function statusError(status) {
  if (status === 400) return { error: 'Jira rejected the query (400) — check the assignee name' };
  if (status === 401 || status === 403) return { error: `Jira rejected the credentials (${status})` };
  return { error: `Jira returned ${status}` };
}

function failure(e) {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { error: 'Jira request timed out' };
  return { error: String(e && e.message ? e.message : e) };
}

const mapIssue = (i) => ({
  key: i?.key ?? '',
  summary: i?.fields?.summary ?? '',
  status: i?.fields?.status?.name ?? '',
  type: i?.fields?.issuetype?.name ?? '',
  priority: i?.fields?.priority?.name ?? '',
  updated: i?.fields?.updated ?? null,
});

async function getJson(url, { token, email, fetchImpl = fetch, timeoutMs = 8000 }) {
  const res = await fetchImpl(url, {
    headers: { Authorization: authHeader({ token, email }), Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { httpError: statusError(res.status) };
  return { data: await res.json() };
}

// -> { issues, total, truncated } | { error }
export async function searchIssues(jql, { baseUrl, token, email, fetchImpl = fetch, timeoutMs = 8000, max = 100 } = {}) {
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to list tickets' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to list tickets' };
  const url = `${trimSlashes(baseUrl)}/rest/api/2/search`
    + `?jql=${encodeURIComponent(jql)}`
    + `&maxResults=${encodeURIComponent(max)}`
    + `&fields=${encodeURIComponent(FIELDS)}`;
  try {
    const { httpError, data } = await getJson(url, { token, email, fetchImpl, timeoutMs });
    if (httpError) return httpError;
    const issues = (data?.issues ?? []).map(mapIssue);
    const total = Number.isFinite(data?.total) ? data.total : issues.length;
    // A silently capped list reads as "that's all of it" — say so instead.
    return { issues, total, truncated: total > issues.length };
  } catch (e) { return failure(e); }
}

// -> { people: [{name, displayName}] } | { error }
export async function searchUsers(q, { baseUrl, token, email, fetchImpl = fetch, timeoutMs = 8000, max = 10 } = {}) {
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to search people' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to search people' };
  const url = `${trimSlashes(baseUrl)}/rest/api/2/user/search`
    + `?username=${encodeURIComponent(q)}&maxResults=${encodeURIComponent(max)}`;
  try {
    const { httpError, data } = await getJson(url, { token, email, fetchImpl, timeoutMs });
    if (httpError) return httpError;
    const people = (Array.isArray(data) ? data : [])
      .filter((u) => u && u.active !== false)
      .map((u) => ({ name: u.name, displayName: u.displayName || u.name }));
    return { people };
  } catch (e) { return failure(e); }
}

// -> { name, displayName } | { error }
export async function me({ baseUrl, token, email, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to identify you' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to identify you' };
  try {
    const { httpError, data } = await getJson(`${trimSlashes(baseUrl)}/rest/api/2/myself`, { token, email, fetchImpl, timeoutMs });
    if (httpError) return httpError;
    return { name: data?.name ?? '', displayName: data?.displayName || data?.name || '' };
  } catch (e) { return failure(e); }
}

// -> { summary, description } | { error } — one call, both fields, for the
// Cursor-brief round: a per-ticket markdown brief needs the ticket's own
// description, not just the summary the list search already carries (see
// lib/actions.mjs's writeTicketBrief). A failure here is the CALLER's to
// degrade (a brief still gets written, its description line just reads
// "description unavailable") — this function's own contract is only "never
// throw, always a sentence when something's wrong".
export async function fetchIssueDetail(key, { baseUrl, token, email, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!key) return { error: 'no ticket key given' };
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to fetch ticket details' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to fetch ticket details' };
  const url = `${trimSlashes(baseUrl)}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent('summary,description')}`;
  try {
    const { httpError, data } = await getJson(url, { token, email, fetchImpl, timeoutMs });
    if (httpError) return httpError;
    return {
      summary: data?.fields?.summary ?? '',
      // API v2 (this server is self-hosted Jira, not Cloud) returns
      // `description` as a plain wiki-markup string, not an ADF object —
      // coerced defensively anyway so an unexpected shape degrades to an
      // empty string rather than a raw "[object Object]" in the brief.
      description: typeof data?.fields?.description === 'string' ? data.fields.description : '',
    };
  } catch (e) { return failure(e); }
}

// Successes memoise briefly so re-opening the modal costs nothing. Failures
// are NOT cached: fixing a token in config.json must take effect on the next
// click, not a minute later.
export function createTicketCache({ ttlMs = 60_000, nowMs = () => Date.now() } = {}) {
  const hits = new Map(); // key -> { result, at }
  return {
    async get(key, fetcher, { force = false } = {}) {
      const cached = hits.get(key);
      if (!force && cached && nowMs() - cached.at < ttlMs) return cached.result;
      const result = await fetcher();
      if (!result.error) hits.set(key, { result, at: nowMs() });
      return result;
    },
  };
}
