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

  it('labels drawings and canvases that link to the note, without a line number', async () => {
    initI18n('en');
    const mock = installWailsMock();
    const v = await api.vault.open('/v/Demo2');
    const files = mock.vaults.get(v.id)?.files;
    files?.set('Target.md', '# Target');
    files?.set(
      'Maps/Sketch.excalidraw',
      JSON.stringify({ elements: [{ id: 'a', type: 'rectangle', link: '[[Target]]' }] }),
    );
    files?.set(
      'Board.canvas',
      JSON.stringify({
        nodes: [{ id: 'n', type: 'file', x: 0, y: 0, width: 1, height: 1, file: 'Target.md' }],
        edges: [],
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BacklinksPanel vaultId={v.id} path="Target.md" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Drawing: Sketch')).toBeInTheDocument();
    expect(screen.getByText('Canvas: Board')).toBeInTheDocument();
    expect(screen.getByText('Backlinks (2)')).toBeInTheDocument();
    expect(screen.queryByText(/line/i)).toBeNull();
  });
});
