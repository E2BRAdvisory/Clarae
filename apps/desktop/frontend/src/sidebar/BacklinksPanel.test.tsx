import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BacklinksPanel } from './BacklinksPanel';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';

describe('BacklinksPanel', () => {
  it('lists notes linking to the open note', async () => {
    initI18n('en');
    const mock = installWailsMock();
    const v = await api.vault.open('/v/Demo');
    const files = mock.vaults.get(v.id)?.files;
    files?.set('Target.md', '# Target');
    files?.set('Other.md', 'See [[Target]]');
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BacklinksPanel vaultId={v.id} path="Target.md" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Other')).toBeInTheDocument();
    expect(screen.getByText('Backlinks (1)')).toBeInTheDocument();
  });
});
