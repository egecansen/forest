import path from 'node:path';
import type { RunConfig } from './types.js';

type Result = { ok: true; value: Omit<RunConfig, 'runId'> } | { ok: false; error: string };

const TB_RE = /^tb[0-9]{1,4}$/;

/** Parses + validates a triage run body. `allowlist` = kit es.host_allowlist. */
export function normalizeRunBody(body: unknown, allowlist: string[]): Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.projectPath !== 'string' || !b.projectPath.trim()) return { ok: false, error: 'projectPath is required' };
  if (typeof b.targetUrl !== 'string' || !b.targetUrl.trim()) return { ok: false, error: 'report URL is required' };
  if (b.testbox !== undefined && typeof b.testbox !== 'string') return { ok: false, error: 'testbox must look like tb161' };

  const demo = b.demo === true;

  let testbox: string;
  let targetUrl: string;

  // Demo submissions are scripted (no real Jenkins/ES lookup, no allowlisted
  // host) — the client already relaxes these checks for `demo: true`, so the
  // server must too, or a malformed-but-legitimate demo POST 400s. Only
  // projectPath/targetUrl presence and testbox's *type* are still enforced.
  if (demo) {
    const rawTestbox = typeof b.testbox === 'string' ? b.testbox.trim() : '';
    testbox = rawTestbox || 'tb0';
    targetUrl = b.targetUrl.trim();
  } else {
    if (typeof b.testbox !== 'string' || !TB_RE.test(b.testbox.trim())) {
      return { ok: false, error: 'testbox must look like tb161' };
    }
    let u: URL;
    try { u = new URL(b.targetUrl.trim()); } catch { return { ok: false, error: 'report URL is not a valid URL' }; }
    if (!allowlist.includes(u.origin)) return { ok: false, error: `report host not allowlisted: ${u.origin}` };
    if (!u.searchParams.get('fullTestBuildName')) return { ok: false, error: 'report URL missing fullTestBuildName' };
    if (!/^[0-9]+$/.test(u.searchParams.get('buildStartTime') ?? '')) return { ok: false, error: 'report URL missing/invalid buildStartTime' };
    testbox = b.testbox.trim();
    targetUrl = u.toString();
  }

  return {
    ok: true,
    value: {
      projectPath: path.resolve(b.projectPath.trim()),
      targetUrl,
      testbox,
      mode: 'triage',
      permissionPolicy: b.permissionPolicy === 'autonomous' ? 'autonomous' : 'confirm-applies',
      projectMode: b.projectMode === 'continue' ? 'continue' : 'new',
      demo,
    },
  };
}
