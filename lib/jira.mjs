// lib/jira.mjs — turning a branch's ticket into a description
//
// Pure helpers plus one network call, which takes its `fetch` as an argument so
// the whole module is testable without a Jira. Nothing here throws: a Jira that
// is unreachable, unauthorised or simply not configured must degrade to a
// link-only description, never break the drawer.

const trimSlashes = (s) => String(s ?? '').replace(/\/+$/, '');

// The branch's ticket key re-keyed onto the configured project.
//
// Branch names carry a team prefix by convention (tech/WEBT-229553,
// fun/QUICKLY-245363) while the issues themselves may live in one project. With
// `projectKey` empty — the default, and what every repo that does not do this
// wants — the ticket passes through untouched.
export function jiraKey(ticket, projectKey) {
  if (!ticket) return null;
  if (!projectKey) return ticket;
  const m = String(ticket).match(/-(\d+)$/);
  // No trailing number means there is nothing to re-key. Returning the ticket
  // unchanged lets the fetch 404 honestly instead of inventing a key.
  return m ? `${projectKey}-${m[1]}` : ticket;
}

export function browseUrl(baseUrl, key) {
  const base = trimSlashes(baseUrl);
  if (!base || !key) return null;
  return `${base}/browse/${key}`;
}

// What lands in the textarea when the user has not written their own.
export function composeDescription({ summary, url }) {
  const title = String(summary ?? '').trim();
  return [title || null, url || null].filter(Boolean).join('\n');
}

export function authHeader({ token, email }) {
  if (email) return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  return `Bearer ${token}`;
}

// -> { summary: string|null } | { error: string }
//
// `error` is a sentence the drawer shows verbatim under the box, so each one
// names what to do about it rather than just what went wrong.
export async function fetchSummary(key, { baseUrl, token, email, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!key) return { summary: null }; // a branch with no ticket: nothing to fetch, not a failure
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to fetch titles' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to fetch titles' };

  const url = `${trimSlashes(baseUrl)}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: authHeader({ token, email }), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return statusError(res.status, key);
    const data = await res.json();
    return { summary: data?.fields?.summary ?? null };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { error: 'Jira request timed out' };
    return { error: String(e && e.message ? e.message : e) };
  }
}

// -> { ok: true, already?: true } | { conflict: string } | { error: string }
//
// Read-before-write: the one extra GET buys never silently clobbering a value
// someone else put in the field. `force` is the caller saying the user has
// seen the conflict and chosen to overwrite.
function statusError(status, key) {
  if (status === 401 || status === 403) return { error: `Jira rejected the credentials (${status})` };
  if (status === 404) return { error: `${key} not found in Jira` };
  return { error: `Jira returned ${status}` };
}

// -> { value: string|null } | { error: string } — the field's current value,
// trimmed; empty/whitespace reads as null. The drawer uses this to highlight
// tickets whose branch field is still unfilled.
export async function readBranchField(key, { baseUrl, token, email, fieldId, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!key) return { error: 'this worktree has no ticket to read from' };
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to read the branch field' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to read the branch field' };
  if (!fieldId) return { error: 'set jiraBranchFieldId in config.json to read the branch field' };
  const url = `${trimSlashes(baseUrl)}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fieldId)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: authHeader({ token, email }), Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return statusError(res.status, key);
    const held = String((await res.json())?.fields?.[fieldId] ?? '').trim();
    return { value: held || null };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { error: 'Jira request timed out' };
    return { error: String(e && e.message ? e.message : e) };
  }
}

export async function submitBranchField(key, branch, { baseUrl, token, email, fieldId, force = false, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!key) return { error: 'this worktree has no ticket to submit to' };
  if (!branch) return { error: 'this worktree has no branch to submit' };
  if (!trimSlashes(baseUrl)) return { error: 'set jiraBaseUrl in config.json to submit the branch' };
  if (!token) return { error: 'set jiraToken (or FOREST_JIRA_TOKEN) to submit the branch' };
  if (!fieldId) return { error: 'set jiraBranchFieldId in config.json to submit the branch' };

  const read = await readBranchField(key, { baseUrl, token, email, fieldId, fetchImpl, timeoutMs });
  if (read.error) return { error: read.error };
  const held = read.value ?? '';
  if (held === branch) return { ok: true, already: true };
  if (held && !force) return { conflict: held };
  try {
    const write = await fetchImpl(`${trimSlashes(baseUrl)}/rest/api/2/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { Authorization: authHeader({ token, email }), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { [fieldId]: branch } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!write.ok) return statusError(write.status, key);
    return { ok: true };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return { error: 'Jira request timed out' };
    return { error: String(e && e.message ? e.message : e) };
  }
}

// Memoises summaries for the server's lifetime, so re-opening a drawer costs
// nothing. Failures are cached too — a Jira that is down must not be retried on
// every drawer open — but only briefly, so fixing a token in config.json does
// not require a restart. Successes never expire: an issue title that changes
// mid-session is not worth a request per open.
export function createSummaryCache({ failTtlMs = 60_000, nowMs = () => Date.now() } = {}) {
  const hits = new Map(); // key -> { result, at }
  return {
    async get(key, opts) {
      const cached = hits.get(key);
      if (cached && (!cached.result.error || nowMs() - cached.at < failTtlMs)) return cached.result;
      const result = await fetchSummary(key, opts);
      hits.set(key, { result, at: nowMs() });
      return result;
    },
  };
}
