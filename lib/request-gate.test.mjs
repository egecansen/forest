import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateRequest } from './request-gate.mjs';

const req = (over = {}) => ({ method: 'POST', url: '/api/launch', headers: { host: '127.0.0.1:5577', 'content-type': 'application/json' }, ...over });
const h = (extra) => ({ host: '127.0.0.1:5577', 'content-type': 'application/json', ...extra });
const OPTS = { port: 5577, srpOrigin: 'https://srp.example' };

test('gateRequest: table', () => {
  const cases = [
    // description, request, expected status (0 = ok)
    ['own page, JSON POST', req({ headers: h({ origin: 'http://127.0.0.1:5577' }) }), 0],
    ['no Origin at all (curl, the guided notify)', req(), 0],
    ['localhost host with matching origin', req({ headers: h({ host: 'localhost:5577', origin: 'http://localhost:5577' }) }), 0],
    ['IPv6 loopback', req({ headers: h({ host: '[::1]:5577', origin: 'http://[::1]:5577' }) }), 0],
    ['GET static with own host', req({ method: 'GET', url: '/', headers: { host: '127.0.0.1:5577' } }), 0],
    ['GET SSE with own host', req({ method: 'GET', url: '/api/events', headers: { host: '127.0.0.1:5577' } }), 0],
    ['foreign Origin (CSRF)', req({ headers: h({ origin: 'https://evil.example' }) }), 403],
    ['Origin "null"', req({ headers: h({ origin: 'null' }) }), 403],
    ['DNS rebinding: foreign Host', req({ headers: h({ host: 'evil.example:5577' }) }), 403],
    ['wrong port in Host', req({ headers: h({ host: '127.0.0.1:5578' }) }), 403],
    ['missing Host', req({ headers: { 'content-type': 'application/json' } }), 403],
    ['text/plain POST to an API route (CORS-simple)', req({ headers: h({ 'content-type': 'text/plain' }) }), 415],
    ['no content type on an API POST', req({ headers: { host: '127.0.0.1:5577' } }), 415],
    ['JSON with a charset parameter', req({ headers: h({ 'content-type': 'application/json; charset=utf-8' }) }), 0],
    ['content type is case-insensitive', req({ headers: h({ 'content-type': 'Application/JSON' }) }), 0],
    ['SRP token POST from the SRP origin with text/plain', req({ url: '/api/srp/token', headers: h({ origin: 'https://srp.example', 'content-type': 'text/plain' }) }), 0],
    ['SRP token OPTIONS preflight from the SRP origin', req({ method: 'OPTIONS', url: '/api/srp/token', headers: { host: '127.0.0.1:5577', origin: 'https://srp.example' } }), 0],
    ['SRP token from any other origin', req({ url: '/api/srp/token', headers: h({ origin: 'https://evil.example', 'content-type': 'text/plain' }) }), 403],
    ['SRP token when no SRP origin is configured', req({ url: '/api/srp/token', headers: h({ origin: 'https://srp.example' }) }), 403],
    ['application/json5 is not JSON', req({ headers: h({ 'content-type': 'application/json5' }) }), 415],
    ['application/json-patch+json is not JSON', req({ headers: h({ 'content-type': 'application/json-patch+json' }) }), 415],
    ['application/jsonp is not JSON', req({ headers: h({ 'content-type': 'application/jsonp' }) }), 415],
    ['JSON with surrounding whitespace before the parameter', req({ headers: h({ 'content-type': 'application/json ; charset=utf-8' }) }), 0],
    ['POST to a non-API path skips the content-type rule', req({ url: '/whatever', headers: { host: '127.0.0.1:5577', 'content-type': 'text/plain' } }), 0],
    ['PUT to an API route with text/plain', req({ method: 'PUT', headers: h({ 'content-type': 'text/plain' }) }), 415],
    ['PUT to an API route with application/json', req({ method: 'PUT', headers: h({}) }), 0],
  ];
  for (const [name, r, status] of cases) {
    const opts = name.includes('no SRP origin') ? { port: 5577, srpOrigin: null } : OPTS;
    const out = gateRequest(r, opts);
    if (status === 0) assert.equal(out.ok, true, `${name}: ${out.reason}`);
    else { assert.equal(out.ok, false, name); assert.equal(out.status, status, `${name}: ${out.reason}`); assert.ok(out.reason, name); }
  }
});
