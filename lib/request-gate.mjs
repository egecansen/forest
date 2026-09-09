// The boundary in front of every route (spec §6). Pure: reads method, url
// and headers, touches nothing.
//
// Why each check exists — all three were verified against the running server
// on 2026-09-09:
//   Host    — with no check, a hostile domain resolving to 127.0.0.1 is
//             same-origin with forest in the browser (DNS rebinding) and can
//             READ the journal, diffs and the event stream.
//   Origin  — a browser sends it on every cross-site request; anything but
//             forest's own page is refused. Absent means a non-browser
//             client (curl, the guided-mode notify), admitted on Host alone.
//   Content — a cross-site fetch with a text/plain body is "CORS-simple" and
//             is sent with NO preflight; readBody parsed it as JSON anyway.
//             Requiring application/json on every API request that is not
//             GET, HEAD or OPTIONS closes that, because a cross-site JSON
//             request with a body-bearing method is preflighted and nothing
//             answers it.
// The one exception is /api/srp/token: the SRP bookmarklet posts text/plain
// on purpose and that route is guarded by its exact-origin rule instead.
export function gateRequest(req, { port, srpOrigin = null }) {
  const url = String(req.url || '').split('?')[0];
  const headers = req.headers || {};
  const host = String(headers.host || '').toLowerCase();
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!allowed.includes(host)) return { ok: false, status: 403, reason: `host ${host || '(none)'} is not forest` };
  const isSrpToken = url === '/api/srp/token';
  const origin = headers.origin;
  if (origin !== undefined) {
    if (isSrpToken) {
      if (!srpOrigin || origin !== srpOrigin) return { ok: false, status: 403, reason: `origin ${origin} is not the configured SRP origin` };
    } else if (origin !== `http://${host}`) {
      return { ok: false, status: 403, reason: `origin ${origin} is not forest` };
    }
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && url.startsWith('/api/') && !isSrpToken) {
    const ct = String(headers['content-type'] || '').toLowerCase();
    const mediaType = ct.split(';')[0].trim();
    if (mediaType !== 'application/json') return { ok: false, status: 415, reason: `content-type ${ct || '(none)'} is not application/json` };
  }
  return { ok: true };
}
