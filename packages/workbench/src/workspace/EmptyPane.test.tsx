import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmptyPane } from './EmptyPane';
import { activeTab, allPanes, emptyLayout, splitPane } from './layout';
import { api, linkInfo, type VaultInfo } from '../app/api';
import { formatCombo } from '../commands/hotkeys';
import { initI18n } from '../i18n';
import { installWailsMock } from '../test/wails-mock';
import { useManaged } from '../state/managed';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';

let vault: VaultInfo;

beforeEach(async () => {
  initI18n('en');
  installWailsMock();
  useSettings.getState().reset();
  useManaged.setState({ features: {} });
  useSync.setState({ info: {} });
  vault = await api.vault.open('/vaults/Empty');
  useAppStore.getState().setVault(vault);
  useAppStore.setState({ layout: emptyLayout() });
});
afterEach(cleanup);

const paneId = () => useAppStore.getState().layout.activePane;
const names = () => screen.getAllByRole('button').map((b) => b.textContent);

describe('a pane with nothing open', () => {
  it('offers the commands that create or open something, with their hotkeys', () => {
    render(<EmptyPane paneId={paneId()} />);
    expect(screen.getByRole('group', { name: 'Start here' })).toBeInTheDocument();
    // note, canvas, drawing, presentation, base, and the applications that are on by default
    expect(names()).toHaveLength(6);
    const note = screen.getByRole('button', { name: /New note/ });
    expect(note).toBeEnabled();
    expect(note).toHaveTextContent(formatCombo('Mod-n'));
    expect(note).toHaveAttribute('aria-keyshortcuts');
    // no hotkey by default: no key shown
    expect(screen.getByRole('button', { name: /New canvas/ }).querySelector('kbd')).toBeNull();
  });

  it('shows the hotkey the user chose', () => {
    act(() => useSettings.getState().setHotkeys({ 'note:new': ['Mod-Shift-j'] }));
    render(<EmptyPane paneId={paneId()} />);
    expect(screen.getByRole('button', { name: /New note/ })).toHaveTextContent(
      formatCombo('Mod-Shift-j'),
    );
  });

  it('leaves out a function the profile turned off', () => {
    act(() => useManaged.setState({ features: { canvas: false, presentations: false } }));
    render(<EmptyPane paneId={paneId()} />);
    expect(screen.queryByRole('button', { name: /New canvas/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New presentation/ })).toBeNull();
    expect(screen.getByRole('button', { name: /New drawing/ })).toBeEnabled();
  });

  it('keeps the commands, disabled, on a vault that may not be changed', () => {
    act(() =>
      useSync.setState({
        info: {
          [vault.id]: linkInfo({ linked: true, mount: true, permission: 'viewer', readOnly: true }),
        },
      }),
    );
    render(<EmptyPane paneId={paneId()} />);
    expect(screen.getByRole('button', { name: /New note/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /New drawing/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Quick switcher/ })).toBeEnabled();
  });

  it('runs the command in its own pane, also when another one has the focus', async () => {
    // Two panes: the second one has the focus, the buttons of the first one are used.
    const first = paneId();
    act(() =>
      useAppStore.setState({
        layout: splitPane(useAppStore.getState().layout, first, 'row', 'live'),
      }),
    );
    expect(allPanes(useAppStore.getState().layout.root)).toHaveLength(2);
    expect(paneId()).not.toBe(first);
    render(<EmptyPane paneId={first} />);
    fireEvent.click(screen.getByRole('button', { name: /New note/ }));
    await waitFor(() => expect(activeTab(useAppStore.getState().layout)).not.toBeNull());
    const layout = useAppStore.getState().layout;
    expect(layout.activePane).toBe(first);
    expect(allPanes(layout.root).find((p) => p.id === first)?.tabs).toHaveLength(1);
  });
});

describe('a pane with nothing open and applications', () => {
  it('offers "New application" unless the profile turns applications off', () => {
    // on by default (ADR-0060)
    render(<EmptyPane paneId={paneId()} />);
    expect(screen.getByRole('button', { name: /New application/ })).toBeEnabled();
    cleanup();
    act(() => useManaged.setState({ features: { web_viewer: false } }));
    render(<EmptyPane paneId={paneId()} />);
    expect(screen.queryByRole('button', { name: /New application/ })).toBeNull();
  });
});
