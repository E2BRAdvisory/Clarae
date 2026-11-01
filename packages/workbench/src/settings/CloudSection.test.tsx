import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CloudSection } from './CloudSection';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { configurePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { api } from '../app/api';

describe('CloudSection', () => {
  it('signs in and out', async () => {
    initI18n('en');
    installWailsMock();
    useAppStore.setState({ auth: null });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CloudSection />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Server address'), {
      target: { value: 'https://memobrain.test' },
    });
    fireEvent.click(screen.getByText('Sign in'));
    expect(await screen.findByText('Signed in as Uno')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Sign out'));
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
  });

  it('on the web, where the page owns the session, offers no sign-in or sign-out', async () => {
    initI18n('en');
    installWailsMock();
    configurePlatform({ kind: 'web' });
    try {
      useAppStore.setState({ auth: null });
      const view = render(
        <QueryClientProvider client={new QueryClient()}>
          <CloudSection />
        </QueryClientProvider>,
      );
      expect(screen.queryByLabelText('Server address')).toBeNull();
      expect(screen.queryByText('Sign in')).toBeNull();
      useAppStore.getState().setAuth(await api.auth.login('https://memobrain.test'));
      expect(await screen.findByText('Signed in as Uno')).toBeInTheDocument();
      expect(screen.queryByText('Sign out')).toBeNull();
      view.unmount();
    } finally {
      configurePlatform({ kind: 'desktop' });
    }
  });
});
