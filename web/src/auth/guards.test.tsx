import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

  it('shows the admin placeholder to nodus-admin', async () => {
    renderApp({ path: '/admin', routes: usage, user: { roles: ['nodus-admin'] } });
    expect(await screen.findByText(/coming in a later release/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Administration' })).toBeInTheDocument();
  });
});
