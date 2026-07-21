import path from 'node:path';
import type { RunConfig } from './types.js';

const MODES = ['onboarding', 'coverage-expansion', 'bug-discovery', 'repair', 'companion'] as const;

/** Raw credential override, if the caller supplied one. Never placed on `value`. */
export interface RunSecret {
  apiKey?: string;
  oauthToken?: string;
  /**
   * Raw content of an uploaded prerequisite login-credentials file (usernames/
   * passwords/roles and/or API keys/tokens the target app requires to log in).
   * Held off-snapshot; only the `hasPrereqCreds` display flag survives onto `value`.
   */
  prereqCredentials?: string;
}

type Result =
  | { ok: true; value: Omit<RunConfig, 'runId'>; secret: RunSecret }
  | { ok: false; error: string };

export function normalizeRunBody(body: unknown): Result {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.projectPath !== 'string' || !b.projectPath.trim()) {
    return { ok: false, error: 'projectPath is required' };
  }
  if (typeof b.mode !== 'string' || !MODES.includes(b.mode as (typeof MODES)[number])) {
    return { ok: false, error: `mode must be one of ${MODES.join(', ')}` };
  }
  const runMode = b.runMode === 'depth' ? 'depth' : 'standard';
  const permissionPolicy = b.permissionPolicy === 'restricted' ? 'restricted' : 'autonomous';
  const projectMode = b.projectMode === 'continue' ? 'continue' : 'new';

  // Credential override: the raw secret is split off into its own object and
  // NEVER placed on `value` — only a non-secret display flag survives onto
  // the config that becomes part of the run snapshot.
  const secret: RunSecret = {};
  let usesCustomCredential: RunConfig['usesCustomCredential'] = null;
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) {
    secret.apiKey = b.apiKey.trim();
    usesCustomCredential = 'apiKey';
  } else if (typeof b.oauthToken === 'string' && b.oauthToken.trim()) {
    secret.oauthToken = b.oauthToken.trim();
    usesCustomCredential = 'oauthToken';
  }

  // Prerequisite login-credentials file: raw content goes ONLY into the
  // off-snapshot secret; only the non-secret `hasPrereqCreds` display flag
  // survives onto `value` (which becomes part of the run snapshot).
  let hasPrereqCreds = false;
  if (typeof b.prereqCredentials === 'string' && b.prereqCredentials.trim()) {
    secret.prereqCredentials = b.prereqCredentials.trim();
    hasPrereqCreds = true;
  }

  return {
    ok: true,
    value: {
      projectPath: path.resolve(b.projectPath.trim()),
      targetUrl: typeof b.targetUrl === 'string' ? b.targetUrl : '',
      mode: b.mode as RunConfig['mode'],
      runMode,
      permissionPolicy,
      demo: b.demo === true,
      record: b.record === true,
      projectMode,
      usesCustomCredential,
      hasPrereqCreds,
    },
    secret,
  };
}
