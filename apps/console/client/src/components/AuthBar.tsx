import { useEffect, useRef, useState } from 'react';
import type { AuthStatus } from '../types';

type LoginMethod = 'subscription' | 'console';

interface LoginState {
  inProgress: boolean;
  url: string | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_CAP_MS = 3 * 60 * 1000;

/**
 * Self-contained "who's signed in" bar. Purely
 * informational — it never blocks the run form, only refreshes its own
 * local state.
 */
export function AuthBar() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [useConsole, setUseConsole] = useState(false);
  const mountedRef = useRef(true);

  const refresh = async () => {
    try {
      const res = await fetch('/api/auth-status');
      if (mountedRef.current && res.ok) setAuth((await res.json()) as AuthStatus);
    } catch {
      // best-effort — leave auth as-is, the bar just won't update.
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Poll auth-status + login-state every 2s while a sign-in is in flight.
  // Stops on success, on an error from the login process, on cancel, on the
  // ~3-minute cap, or on unmount (all guarded by `ignore` below).
  useEffect(() => {
    if (!signingIn) return;
    let ignore = false;
    const startedAt = Date.now();

    const tick = async () => {
      if (ignore || !mountedRef.current) return;
      try {
        const [statusRes, stateRes] = await Promise.all([
          fetch('/api/auth-status'),
          fetch('/api/auth-login/state'),
        ]);
        if (ignore || !mountedRef.current) return;

        const status = statusRes.ok ? ((await statusRes.json()) as AuthStatus) : null;
        if (status?.loggedIn) {
          setAuth(status);
          setSigningIn(false);
          setLoginUrl(null);
          setLoginError(null);
          return;
        }

        const state = stateRes.ok ? ((await stateRes.json()) as LoginState) : null;
        if (state) {
          setLoginUrl(state.url);
          setLoginError(state.error);
          if (state.error) {
            setSigningIn(false);
            return;
          }
        }

        if (Date.now() - startedAt > POLL_CAP_MS) {
          setLoginError('sign-in timed out — try again');
          setSigningIn(false);
        }
      } catch {
        // transient fetch failure — keep polling until the cap catches it.
      }
    };

    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      ignore = true;
      window.clearInterval(id);
    };
  }, [signingIn]);

  const startSignIn = async (method: LoginMethod) => {
    setLoginError(null);
    setLoginUrl(null);
    setSigningIn(true);
    try {
      const res = await fetch('/api/auth-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method }),
      });
      const json = (await res.json()) as { started: boolean; error?: string };
      if (!mountedRef.current) return;
      if (!json.started && json.error) setLoginError(json.error);
    } catch {
      if (mountedRef.current) {
        setLoginError('could not reach the server to start sign-in');
        setSigningIn(false);
      }
    }
  };

  const cancel = async () => {
    setSigningIn(false);
    setLoginUrl(null);
    setLoginError(null);
    try {
      await fetch('/api/auth-login/cancel', { method: 'POST' });
    } catch {
      // best-effort — the in-flight login will still time out server-side.
    }
  };

  const signOut = async () => {
    try {
      await fetch('/api/auth-logout', { method: 'POST' });
    } catch {
      // best-effort
    }
    void refresh();
  };

  const switchAccount = async () => {
    try {
      await fetch('/api/auth-logout', { method: 'POST' });
    } catch {
      // best-effort
    }
    await startSignIn(useConsole ? 'console' : 'subscription');
  };

  if (!auth) return null;

  if (signingIn) {
    return (
      <div className="auth-bar auth-bar-signing-in">
        <p className="auth-line">→ complete sign-in in your browser…</p>
        {loginUrl && (
          <a className="auth-url" href={loginUrl} target="_blank" rel="noreferrer">
            {loginUrl}
          </a>
        )}
        {loginError && <p className="auth-error">{loginError}</p>}
        <button type="button" className="auth-action" onClick={() => void cancel()}>
          cancel
        </button>
      </div>
    );
  }

  if (auth.loggedIn) {
    return (
      <div className="auth-bar">
        <p className="auth-line">
          ◆ signed in as {auth.email} · {auth.subscriptionType ?? auth.authMethod}
        </p>
        <div className="auth-actions">
          <button type="button" className="auth-action" onClick={() => void switchAccount()}>
            switch account
          </button>
          <button type="button" className="auth-action" onClick={() => void signOut()}>
            sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-bar">
      <p className="auth-line auth-warn">⚠ not signed in</p>
      <div className="auth-actions">
        <button type="button" className="sign-in-btn" onClick={() => void startSignIn(useConsole ? 'console' : 'subscription')}>
          sign in
        </button>
        <label className="auth-billing-toggle">
          <input type="checkbox" checked={useConsole} onChange={(e) => setUseConsole(e.target.checked)} />
          API billing
        </label>
      </div>
    </div>
  );
}
