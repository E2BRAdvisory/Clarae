import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TabBar } from './TabBar';
import { activeTab, allPanes, emptyLayout, findPane, openPath, type Layout } from './layout';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { useSettings } from '../state/settings';

function layoutOf(...paths: string[]): Layout {
  let l = emptyLayout();
  paths.forEach((p, i) => (l = openPath(l, p, { mode: 'live', newTab: i > 0 })));
  return l;
}

const pane = () => allPanes(useAppStore.getState().layout.root)[0]!;
const open = async (name: RegExp) => {
  fireEvent.contextMenu(screen.getByRole('tab', { name }));
  return screen.findByRole('menu');
};

describe('tab context menu', () => {
  beforeEach(() => {
    initI18n('en');
    useSettings.getState().reset();
    useAppStore.setState({ layout: layoutOf('a.md', 'b.md', 'c.md') });
  });

  it('offers lock, close, close right/left/others/all', async () => {
    render(<TabBar pane={pane()} />);
    await open(/^b$/);
    for (const name of [
      'Lock tab',
      'Close',
      'Close tabs to the right',
      'Close tabs to the left',
      'Close other tabs',
      'Close all tabs',
    ])
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
  });

  it('locks a tab: it shows as locked, cannot be closed and survives "close all"', async () => {
    const { rerender } = render(<TabBar pane={pane()} />);
    await open(/^b$/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lock tab' }));
    rerender(<TabBar pane={pane()} />);
    expect(screen.getByRole('tab', { name: 'b (locked)' })).toBeInTheDocument();

    await open(/b \(locked\)/);
    expect(screen.getByRole('menuitem', { name: 'Unlock tab' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Close' })).toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close all tabs' }));
    rerender(<TabBar pane={pane()} />);
    expect(pane().tabs.map((t) => t.path)).toEqual(['b.md']);
  });

  it('disables a bulk close that would close nothing', async () => {
    render(<TabBar pane={pane()} />);
    await open(/^c$/); // the last tab: nothing to its right
    expect(screen.getByRole('menuitem', { name: 'Close tabs to the right' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Close tabs to the left' })).toBeEnabled();
  });

  it('closes the tabs to the left of the one clicked', async () => {
    const { rerender } = render(<TabBar pane={pane()} />);
    await open(/^b$/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close tabs to the left' }));
    rerender(<TabBar pane={pane()} />);
    const l = useAppStore.getState().layout;
    expect(findPane(l, l.activePane)?.tabs.map((t) => t.path)).toEqual(['b.md', 'c.md']);
    expect(activeTab(l)?.path).toBe('b.md');
  });
});
