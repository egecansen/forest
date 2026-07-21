import { describe, it, expect } from 'vitest';
import { normalizeRunBody } from '../validate.js';

describe('normalizeRunBody', () => {
  it('rejects a missing project path', () => {
    const r = normalizeRunBody({ mode: 'onboarding' });
    expect(r.ok).toBe(false);
  });

  it('defaults runMode=standard and permissionPolicy=autonomous', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding' });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.value.runMode).toBe('standard');
      expect(r.value.permissionPolicy).toBe('autonomous');
      expect(r.value.projectPath).toBe('/tmp/x');
    }
  });

  it('passes through valid runMode + permissionPolicy', () => {
    const r = normalizeRunBody({
      projectPath: '/tmp/x',
      mode: 'bug-discovery',
      runMode: 'depth',
      permissionPolicy: 'restricted',
    });
    expect(r.ok && r.value.runMode).toBe('depth');
    expect(r.ok && r.value.permissionPolicy).toBe('restricted');
  });

  it('rejects an unknown mode', () => {
    expect(normalizeRunBody({ projectPath: '/x', mode: 'nope' }).ok).toBe(false);
  });

  it("defaults projectMode to 'new'", () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding' });
    expect(r.ok && r.value.projectMode).toBe('new');
  });

  it("passes through projectMode 'continue'", () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', projectMode: 'continue' });
    expect(r.ok && r.value.projectMode).toBe('continue');
  });

  it("coerces an invalid projectMode to 'new'", () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', projectMode: 'bogus' });
    expect(r.ok && r.value.projectMode).toBe('new');
  });

  it('with no credential in the body, secret is empty and usesCustomCredential is null', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret.apiKey).toBeUndefined();
    expect(r.secret.oauthToken).toBeUndefined();
    expect(r.value.usesCustomCredential).toBeNull();
    expect(JSON.stringify(r.value)).not.toContain('sk-ant');
  });

  it('splits an apiKey into secret, leaving only the display flag on value', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', apiKey: 'sk-ant-xxx' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret.apiKey).toBe('sk-ant-xxx');
    expect(r.secret.oauthToken).toBeUndefined();
    expect(r.value.usesCustomCredential).toBe('apiKey');
    // The raw secret must never leak onto `value` (the config half streamed to clients).
    expect(JSON.stringify(r.value)).not.toContain('sk-ant-xxx');
    expect((r.value as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('splits an oauthToken into secret, leaving only the display flag on value', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', oauthToken: 'oauth-tok-yyy' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret.oauthToken).toBe('oauth-tok-yyy');
    expect(r.secret.apiKey).toBeUndefined();
    expect(r.value.usesCustomCredential).toBe('oauthToken');
    expect(JSON.stringify(r.value)).not.toContain('oauth-tok-yyy');
    expect((r.value as Record<string, unknown>).oauthToken).toBeUndefined();
  });

  it('apiKey takes precedence over oauthToken when both are supplied', () => {
    const r = normalizeRunBody({
      projectPath: '/tmp/x',
      mode: 'onboarding',
      apiKey: 'sk-ant-xxx',
      oauthToken: 'oauth-tok-yyy',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.usesCustomCredential).toBe('apiKey');
    expect(r.secret.apiKey).toBe('sk-ant-xxx');
    expect(r.secret.oauthToken).toBeUndefined();
  });

  it('ignores blank/whitespace-only credential strings', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', apiKey: '   ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret.apiKey).toBeUndefined();
    expect(r.value.usesCustomCredential).toBeNull();
  });

  it('reads record: true into value.record', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', record: true });
    expect(r.ok && r.value.record).toBe(true);
  });

  it('defaults record to false when absent', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding' });
    expect(r.ok && r.value.record).toBe(false);
  });

  it('coerces a non-true record value to false', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', record: 'yes' });
    expect(r.ok && r.value.record).toBe(false);
  });

  it('splits prereqCredentials into secret, leaving only the hasPrereqCreds flag on value', () => {
    const creds = 'admin@app.com : Adm1nP@ss1 : admin';
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', prereqCredentials: creds });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret.prereqCredentials).toBe(creds);
    expect(r.value.hasPrereqCreds).toBe(true);
    // The raw credential content must never leak onto `value` (the config half
    // streamed to clients / persisted in the snapshot).
    expect(JSON.stringify(r.value)).not.toContain('Adm1nP@ss1');
    expect(JSON.stringify(r.value)).not.toContain('admin@app.com');
    expect((r.value as Record<string, unknown>).prereqCredentials).toBeUndefined();
  });

  it('trims prereqCredentials before storing it in secret', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', prereqCredentials: '  Adm1nP@ss1  ' });
    expect(r.ok && r.secret.prereqCredentials).toBe('Adm1nP@ss1');
  });

  it('leaves hasPrereqCreds falsy and secret.prereqCredentials undefined when absent', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret.prereqCredentials).toBeUndefined();
    expect(r.value.hasPrereqCreds).toBeFalsy();
  });

  it('ignores a blank/whitespace-only prereqCredentials string', () => {
    const r = normalizeRunBody({ projectPath: '/tmp/x', mode: 'onboarding', prereqCredentials: '   ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret.prereqCredentials).toBeUndefined();
    expect(r.value.hasPrereqCreds).toBeFalsy();
  });
});
