import { describe, it, expect } from 'vitest';
import { isAllowedHost } from '../host-guard.js';

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
