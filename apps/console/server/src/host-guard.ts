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
