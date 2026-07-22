import { describe, it, expect } from 'vitest';
import { isAllowedHost, isAllowedOrigin } from '../host-guard.js';

describe('isAllowedHost', () => {
  it('allows localhost with a port', () => {
    expect(isAllowedHost('localhost:8765', 8765)).toBe(true);
  });

  it('allows 127.0.0.1 with a port', () => {
    expect(isAllowedHost('127.0.0.1:8765', 8765)).toBe(true);
  });

  it('allows bracketed IPv6 loopback with a port', () => {
    expect(isAllowedHost('[::1]:8765', 8765)).toBe(true);
  });

  it('allows bare localhost without a port', () => {
    expect(isAllowedHost('localhost', 8765)).toBe(true);
  });

  it('rejects an attacker-controlled host (DNS rebinding)', () => {
    expect(isAllowedHost('attacker.com:8765', 8765)).toBe(false);
  });

  it('rejects an unrelated host with no port', () => {
    expect(isAllowedHost('evil.com', 8765)).toBe(false);
  });

  it('rejects a missing host header', () => {
    expect(isAllowedHost(undefined, 8765)).toBe(false);
  });

  it('rejects an empty host header', () => {
    expect(isAllowedHost('', 8765)).toBe(false);
  });

  it('allows bare IPv6 loopback with no brackets or port', () => {
    expect(isAllowedHost('::1', 8765)).toBe(true);
  });

  it('allows bracketed IPv6 loopback with a port (repeat, explicit)', () => {
    expect(isAllowedHost('[::1]:8765', 8765)).toBe(true);
  });

  it('allows bracketed IPv6 loopback with no port', () => {
    expect(isAllowedHost('[::1]', 8765)).toBe(true);
  });

  it('allows uppercase localhost with a port', () => {
    expect(isAllowedHost('LOCALHOST:8765', 8765)).toBe(true);
  });

  it('rejects a subdomain-suffix spoof of localhost', () => {
    expect(isAllowedHost('localhost.evil.com', 8765)).toBe(false);
  });

  it('rejects a subdomain-suffix spoof of 127.0.0.1', () => {
    expect(isAllowedHost('127.0.0.1.evil.com', 8765)).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('allows a bare localhost origin', () => {
    expect(isAllowedOrigin('http://localhost')).toBe(true);
  });

  it('allows a localhost origin with an arbitrary port (e.g. Vite dev server)', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
  });

  it('allows a 127.0.0.1 origin with an arbitrary port', () => {
    expect(isAllowedOrigin('http://127.0.0.1:34567')).toBe(true);
  });

  it('allows a bracketed IPv6 loopback origin with a port', () => {
    expect(isAllowedOrigin('http://[::1]:3000')).toBe(true);
  });

  it('allows uppercase-scheme/host origins', () => {
    expect(isAllowedOrigin('HTTP://LOCALHOST:9')).toBe(true);
  });

  it('rejects an unrelated origin', () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
  });

  it('rejects a subdomain-suffix spoof of localhost', () => {
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
  });

  it('rejects a subdomain-suffix spoof of 127.0.0.1', () => {
    expect(isAllowedOrigin('http://127.0.0.1.evil.com')).toBe(false);
  });

  it('allows an absent Origin header (non-browser clients)', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it('rejects a malformed Origin header', () => {
    expect(isAllowedOrigin('not a url')).toBe(false);
  });

  it('rejects an empty Origin header', () => {
    expect(isAllowedOrigin('')).toBe(false);
  });
});
