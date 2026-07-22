/**
 * DNS-rebinding defense: only accept requests whose Host header names this
 * server's own loopback address. The check is hostname-only (the `:port`
 * suffix, if present, is stripped and ignored) — `port` is accepted in the
 * signature so callers can pass their listen port for future port-aware
 * checks without changing the call site.
 *
 * Host parsing is careful about IPv6: a naive `/:\d+$/` port-strip mangles a
 * bare `::1` (it strips everything after the last colon, leaving `:`), so
 * bracketed (`[::1]`, `[::1]:8765`) and bare (`::1`) IPv6 loopback forms are
 * each handled explicitly rather than falling through a single regex.
 */
export function isAllowedHost(host: string | undefined, _port: number): boolean {
  if (!host) return false;
  let hostname = host.trim().toLowerCase();
  const bracket = hostname.match(/^\[(.+?)\](?::\d+)?$/); // [::1] or [::1]:8765
  if (bracket) {
    hostname = bracket[1];
  } else if ((hostname.match(/:/g) || []).length === 1) {
    hostname = hostname.split(':')[0]; // host:port for IPv4/name
  }
  // else: bare IPv6 (multiple colons, no brackets) e.g. ::1 — leave as-is
  const allowed = new Set(['localhost', '127.0.0.1', '::1']);
  return allowed.has(hostname);
}

/**
 * WebSocket-upgrade defense: WebSockets bypass CORS entirely, so any page
 * open in the user's browser can open `ws://localhost:PORT/...` and the
 * browser will happily send it — the Host header alone (checked by
 * `isAllowedHost`) doesn't stop this, since a same-machine page's Host is
 * legitimately `localhost`. The `Origin` header is the only signal that
 * distinguishes "our own client" from "some other open tab" — reject any
 * present Origin that isn't a loopback origin.
 *
 * Absent Origin (undefined) is ALLOWED: non-browser clients (our own tests,
 * CLI tools, curl) never send one, and browsers always do for a WS
 * handshake — so an absent Origin here can't be a browser page attacking us.
 *
 * Any port is accepted for loopback hosts — dev serves the client off
 * Vite's port, not the server's own PORT.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!origin) return false; // empty string: present-but-malformed, not absent
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip [] from IPv6
  const allowed = new Set(['localhost', '127.0.0.1', '::1']);
  return allowed.has(hostname);
}
