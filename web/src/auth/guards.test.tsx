import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fakeAuth, renderApp } from '../test/utils';

const usage = { 'GET /me/usage': { used_bytes: 1, quota_bytes: 100, level: 'ok' } };

describe('auth guard', () => {
  it('sends anonymous visitors to sign in, remembering where they wanted to go', async () => {
    const auth = fakeAuth(null);
    renderApp({ path: '/vaults?x=1', auth, routes: usage });
    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith('/vaults?x=1'));
    expect(screen.getByText('Redirecting to sign in…')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('shows the area to signed-in users and redirects / to the usage page', async () => {
    renderApp({ path: '/', routes: usage });
    expect(await screen.findByRole('heading', { name: 'Storage used' })).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows a failed sign-in with a retry instead of redirecting forever', async () => {
    const auth = fakeAuth(null);
    let fail = true;
    auth.getUser = vi.fn(() =>
      fail ? Promise.reject(new Error('client-config: 502')) : Promise.resolve(null),
    );
    renderApp({ path: '/vaults', auth, routes: usage });
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in could not start');
    expect(auth.signIn).not.toHaveBeenCalled();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith('/vaults'));
  });

  it('shows a sign-in redirect that fails to start', async () => {
    const auth = fakeAuth(null);
    auth.signIn = vi.fn(() => Promise.reject(new Error('idp unreachable')));
    renderApp({ path: '/vaults', auth, routes: usage });
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in could not start');
  });

  it('keeps the callback route public', async () => {
    const auth = fakeAuth(null);
    renderApp({ path: '/auth/callback', auth });
    await waitFor(() => expect(auth.completeSignIn).toHaveBeenCalled());
    expect(auth.signIn).not.toHaveBeenCalled();
  });
});

describe('role guard', () => {
  it('hides the admin area from users without the realm role', async () => {
    renderApp({ path: '/admin', routes: usage });
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Administration' })).not.toBeInTheDocument();
  });

  it('shows the administration console to memobrain-admin', async () => {
    renderApp({
      path: '/admin',
      routes: { ...usage, 'GET /admin/storage/overview': new Response(null, { status: 500 }) },
      user: { roles: ['memobrain-admin'] },
    });
    expect(
      await screen.findByRole('navigation', { name: 'Administration sections' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Administration' })).toBeInTheDocument();
  });

  it('follows the role of /me, not the realm role of an older token (ADR-0041)', async () => {
    // Demoted from the console: the token still has the realm role until it is renewed.
    renderApp({
      path: '/admin',
      routes: { ...usage, 'GET /me': { id: 'u1', username: 'alice', role: 'user' } },
      user: { roles: ['memobrain-admin'] },
    });
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Administration' })).not.toBeInTheDocument();
  });

  it('opens the administration console to an administrator whose token has no realm role yet', async () => {
    renderApp({
      path: '/admin',
      routes: {
        ...usage,
        'GET /me': { id: 'u1', username: 'alice', role: 'admin' },
        'GET /admin/storage/overview': new Response(null, { status: 500 }),
      },
    });
    expect(
      await screen.findByRole('navigation', { name: 'Administration sections' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Administration' })).toBeInTheDocument();
  });
});
