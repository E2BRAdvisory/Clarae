import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CloudSection } from './CloudSection';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { useAppStore } from '../state/store';

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
      target: { value: 'https://nodus.test' },
    });
    fireEvent.click(screen.getByText('Sign in'));
    expect(await screen.findByText('Signed in as Uno')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Sign out'));
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
  });
});
