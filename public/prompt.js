// public/prompt.js — the first message of a ticket-launched session.
//
// Plain ESM with no DOM references so the browser and `node --test` can import
// the same file: the prompt is the contract between forest and the Hektor
// skills, and a second copy of it would drift.
//
// The shape is exactly what the user already typed by hand: ticket LINKS
// (not bare keys — a clickable Jira URL is what they'd paste), joined by
// " - ", then the box(es), same join. No lead-in text, no wave size, no git
// base branch: none of that survives into the prompt any more. What makes
// the session Hektor-capable now is provisioning (see startsSessionSkills in
// tickets.js), not wording in this string.
export function composeTicketPrompt({ tickets = [], boxes = [], jiraBaseUrl = '' } = {}) {
  const keys = (tickets || []).filter(Boolean);
  const list = (boxes || []).filter(Boolean);
  if (!keys.length) return '';
  // A trailing slash on jiraBaseUrl (however it arrived) must not double up
  // against the leading one in `/browse/`.
  const base = String(jiraBaseUrl || '').replace(/\/+$/, '');
  // No jiraBaseUrl configured: a bare key is a working (if less convenient)
  // prompt; `undefined/browse/SHBDN-1` is not.
  const link = (key) => (base ? `${base}/browse/${key}` : key);
  return [...keys.map(link), ...list].join(' - ');
}
