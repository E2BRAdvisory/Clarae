// The desktop sign-in (AuthAPI.Login), shared by Settings > Cloud, Settings > Sync and the account
// button of the ribbon.
import { api, type AuthState } from './api';
import { errorMessage } from '../util/errors';

/**
 * Runs the browser sign-in against serverUrl and returns the new session state. On failure the
 * state carries the reason in the user's language when its code is known: the core refuses some
 * addresses before it changes its state (insecure-url: plain http to another computer), so the
 * state it reports would not say why.
 */
export async function signIn(serverUrl: string): Promise<AuthState> {
  try {
    return await api.auth.login(serverUrl);
  } catch (e) {
    return { ...(await api.auth.status()), error: errorMessage(e) };
  }
}
