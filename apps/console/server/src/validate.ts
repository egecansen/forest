import path from 'node:path';
import type { RunConfig } from './types.js';

type Result = { ok: true; value: Omit<RunConfig, 'runId'> } | { ok: false; error: string };

const TB_RE = /^tb[0-9]{1,4}$/;

/** Parses + validates a triage run body. `allowlist` = kit es.host_allowlist. */
export function normalizeRunBody(body: unknown, allowlist: string[]): Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.projectPath !== 'string' || !b.projectPath.trim()) return { ok: false, error: 'projectPath is required' };
  if (typeof b.targetUrl !== 'string' || !b.targetUrl.trim()) return { ok: false, error: 'report URL is required' };
  if (typeof b.testbox !== 'string' || !TB_RE.test(b.testbox.trim())) return { ok: false, error: 'testbox must look like tb161' };

  let u: URL;
  try { u = new URL(b.targetUrl.trim()); } catch { return { ok: false, error: 'report URL is not a valid URL' }; }
  if (!allowlist.includes(u.origin)) return { ok: false, error: `report host not allowlisted: ${u.origin}` };
  if (!u.searchParams.get('fullTestBuildName')) return { ok: false, error: 'report URL missing fullTestBuildName' };
  if (!/^[0-9]+$/.test(u.searchParams.get('buildStartTime') ?? '')) return { ok: false, error: 'report URL missing/invalid buildStartTime' };

  return {
    ok: true,
    value: {
      projectPath: path.resolve(b.projectPath.trim()),
      targetUrl: u.toString(),
      testbox: b.testbox.trim(),
      mode: 'triage',
      permissionPolicy: b.permissionPolicy === 'autonomous' ? 'autonomous' : 'confirm-applies',
      projectMode: b.projectMode === 'continue' ? 'continue' : 'new',
      demo: b.demo === true,
    },
  };
}
