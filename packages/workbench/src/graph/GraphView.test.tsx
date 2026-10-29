import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GraphView } from './GraphView';
import { api } from '../app/api';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { useGraphSettings } from './settings';
import { runCommand } from '../commands/registry';
import { useAppStore } from '../state/store';
import { emptyLayout, activeTab } from '../workspace/layout';

describe('GraphView', () => {
  beforeEach(() => {
    initI18n('en');
    useGraphSettings.setState({ vaultId: null, loaded: false });
  });

  it('builds the graph from the index and reacts to the filter panel', async () => {
    const mock = installWailsMock();
    const v = await api.vault.open('/v/Graph');
    const files = mock.vaults.get(v.id)?.files;
    files?.set('A.md', '[[B]] [[C]]');
    files?.set('B.md', '[[C]]');
    files?.set('C.md', 'end');
    files?.set('Lonely.md', 'alone');
    render(<GraphView vaultId={v.id} path="graph://global" />);
    expect(await screen.findByText('4 nodes, 3 links')).toBeInTheDocument();
    // Orphans are on by default: turning them off leaves the three linked notes.
    fireEvent.click(screen.getByLabelText('Orphans'));
    expect(await screen.findByText('3 nodes, 3 links')).toBeInTheDocument();
  });

  it('shows the neighbourhood of a note in the local graph', async () => {
    const mock = installWailsMock();
    const v = await api.vault.open('/v/Local');
    const files = mock.vaults.get(v.id)?.files;
    files?.set('A.md', '[[B]]');
    files?.set('B.md', '[[C]]');
    files?.set('C.md', 'end');
    render(<GraphView vaultId={v.id} path="graph://local/A.md" />);
    expect(await screen.findByText('2 nodes, 1 links')).toBeInTheDocument();
    expect(screen.getByText('Depth')).toBeInTheDocument();
  });

  it('exposes keyboard-operable controls', async () => {
    const mock = installWailsMock();
    const v = await api.vault.open('/v/Kbd');
    mock.vaults.get(v.id)?.files.set('A.md', 'x');
    render(<GraphView vaultId={v.id} path="graph://global" />);
    expect(screen.getByTestId('graph-canvas')).toHaveAttribute('tabindex', '0');
    expect(screen.getByLabelText('Play timelapse')).toBeInTheDocument();
    expect(screen.getByLabelText('Fit to screen')).toBeInTheDocument();
  });
});

describe('graph commands', () => {
  it('open the global and the local graph in tabs', async () => {
    initI18n('en');
    installWailsMock();
    const v = await api.vault.open('/v/Cmd');
    useAppStore.setState({ vault: v, layout: emptyLayout() });
    useAppStore.getState().openNote('Note.md');
    await runCommand('graph:open-local');
    expect(activeTab(useAppStore.getState().layout)?.path).toBe('graph://local/Note.md');
    await runCommand('graph:open');
    expect(activeTab(useAppStore.getState().layout)?.path).toBe('graph://global');
  });
});
