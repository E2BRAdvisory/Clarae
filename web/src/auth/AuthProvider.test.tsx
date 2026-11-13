import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createClient } from '@clarae/api-client';
import { fakeAuth } from '../test/utils';
import { AuthProvider, useAuth, type AuthState } from './AuthProvider';
import type { AuthUser } from './types';

describe('AuthProvider getAccessToken', () => {
  it('reads the token at each call, so a client kept by a long export follows the renewals', async () => {
    let current = 'first';
    let notify: (u: AuthUser | null) => void = () => undefined;
    const auth = fakeAuth();
    const userWith = (accessToken: string): AuthUser => ({
      sub: 'u1',
      name: 'Alice',
      roles: [],
      accessToken,
    });
    auth.getUser = () => Promise.resolve(userWith(current));
    auth.onUserChange = (cb) => {
      notify = cb;
      return () => undefined;
    };

    const states: AuthState[] = [];
    function Capture() {
      states.push(useAuth());
      return null;
    }
    render(
      <AuthProvider service={auth}>
        <Capture />
      </AuthProvider>,
    );
    await waitFor(() => expect(states.at(-1)?.user?.accessToken).toBe('first'));
    const getAccessToken = (states.at(-1) as AuthState).getAccessToken;

    // The client the console builds once, with an in-memory fetch that records the header.
    const seen: (string | null)[] = [];
    const api = createClient({
      baseUrl: 'http://localhost/api/v1',
      getAccessToken,
      fetch: (req: Request) => {
        seen.push(req.headers.get('Authorization'));
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    await api.GET('/me');

    // A silent renewal: the session holds a new token, and the provider re-renders.
    current = 'second';
    act(() => notify(userWith('second')));
    await waitFor(() => expect(states.at(-1)?.user?.accessToken).toBe('second'));
    await api.GET('/me');

    expect(seen).toEqual(['Bearer first', 'Bearer second']);
    // The getter does not change with the token: the client (and what captured it) stays the same.
    expect((states.at(-1) as AuthState).getAccessToken).toBe(getAccessToken);
  });
});
