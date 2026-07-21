import type { AuthStatus } from './types.js';

/** Authentication is not wired in this build — the console reports a static
 *  signed-in identity so the full UI renders. */
export async function getAuthStatus(): Promise<AuthStatus> {
  return {
    loggedIn: true,
    authMethod: null,
    apiProvider: null,
    email: 'qa@sahibinden.com',
    orgName: null,
    subscriptionType: null,
    error: null,
  };
}
