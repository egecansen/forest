/** Login flows are not wired in this build — the console always reports the
 *  identity from auth-status. */
export function startLogin(_method: 'subscription' | 'console'): { started: boolean; error?: string } {
  return { started: false, error: 'sign-in is not available in this build' };
}

export function getLoginState(): { inProgress: boolean; url: string | null; error: string | null } {
  return { inProgress: false, url: null, error: null };
}

export function cancelLogin(): void {
  /* nothing in flight */
}

export async function logout(): Promise<{ ok: boolean; error?: string }> {
  return { ok: false, error: 'sign-out is not available in this build' };
}
