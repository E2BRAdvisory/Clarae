import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeTab,
  allPanes,
  closeAllTabs,
  closeOtherTabs,
  closePane,
  closeTab,
  closeTabsLeft,
  closeTabsRight,
  cycleTab,
  emptyLayout,
  findPane,
  moveTab,
  openPath,
  openPaths,
  parseLayout,
  removePath,
  renamePath,
  setActivePane,
  setIdFactory,
  setMode,
  setSizes,
  splitPane,
  toggleLink,
  togglePin,
  type Layout,
} from './layout';

beforeEach(() => {
  let n = 0;
  setIdFactory((prefix) => `${prefix}${++n}`);
});

const open = (l: Layout, path: string, newTab = false, paneId?: string): Layout =>
  openPath(l, path, { mode: 'live', newTab, ...(paneId ? { paneId } : {}) });
const paths = (l: Layout, paneId?: string): string[] =>
  (findPane(l, paneId ?? l.activePane)?.tabs ?? []).map((t) => t.path);

describe('tabs', () => {
  it('opens in the empty pane, replaces the active tab on plain open, adds on newTab', () => {
    let l = open(emptyLayout(), 'a.md');
    expect(paths(l)).toEqual(['a.md']);
    l = open(l, 'b.md');
    expect(paths(l)).toEqual(['b.md']); // replaced
    l = open(l, 'c.md', true);
    expect(paths(l)).toEqual(['b.md', 'c.md']);
    expect(activeTab(l)?.path).toBe('c.md');
  });

  it('activates an existing tab instead of duplicating it', () => {
    let l = open(open(emptyLayout(), 'a.md'), 'b.md', true);
    l = open(l, 'a.md', true);
    expect(paths(l)).toEqual(['a.md', 'b.md']);
    expect(activeTab(l)?.path).toBe('a.md');
  });

  it('closes tabs, activating a neighbour, and keeps one empty pane', () => {
    let l = open(open(open(emptyLayout(), 'a.md'), 'b.md', true), 'c.md', true);
    const b = findPane(l, l.activePane)?.tabs[1]?.id ?? '';
    l = closeTab(l, b);
    expect(paths(l)).toEqual(['a.md', 'c.md']);
    for (const t of [...(findPane(l, l.activePane)?.tabs ?? [])]) l = closeTab(l, t.id);
    expect(allPanes(l.root)).toHaveLength(1);
    expect(paths(l)).toEqual([]);
    expect(activeTab(l)).toBeUndefined();
  });

  it('cycles tabs and changes the mode of one tab', () => {
    let l = open(open(emptyLayout(), 'a.md'), 'b.md', true);
    l = cycleTab(l, 1);
    expect(activeTab(l)?.path).toBe('a.md');
    l = cycleTab(l, -1);
    expect(activeTab(l)?.path).toBe('b.md');
    l = setMode(l, activeTab(l)?.id ?? '', 'reading');
    expect(activeTab(l)?.mode).toBe('reading');
    expect(findPane(l, l.activePane)?.tabs[0]?.mode).toBe('live');
  });
});

describe('locked tabs and bulk close', () => {
  // a b c d e, with the id of each tab by path
  const five = (): { l: Layout; id: Record<string, string> } => {
    let l = open(emptyLayout(), 'a.md');
    for (const p of ['b.md', 'c.md', 'd.md', 'e.md']) l = open(l, p, true);
    const id = Object.fromEntries(
      (findPane(l, l.activePane)?.tabs ?? []).map((t) => [t.path[0] as string, t.id]),
    );
    return { l, id };
  };

  it('closes to the right, to the left, the others, and all', () => {
    const { l, id } = five();
    expect(paths(closeTabsRight(l, id['c'] ?? ''))).toEqual(['a.md', 'b.md', 'c.md']);
    expect(paths(closeTabsLeft(l, id['c'] ?? ''))).toEqual(['c.md', 'd.md', 'e.md']);
    expect(paths(closeOtherTabs(l, id['c'] ?? ''))).toEqual(['c.md']);
    expect(paths(closeAllTabs(l, l.activePane))).toEqual([]);
  });

  it('activates the nearest remaining tab when the active one is closed', () => {
    const { l, id } = five();
    // e is active; closing everything left of it keeps it
    expect(activeTab(closeTabsLeft(l, id['e'] ?? ''))?.path).toBe('e.md');
    // c active, close the others but a: the next one to the right is gone, so the last remains
    const c = open(l, 'c.md');
    const kept = closeTabsRight(c, id['b'] ?? '');
    expect(paths(kept)).toEqual(['a.md', 'b.md']);
    expect(activeTab(kept)?.path).toBe('b.md');
  });

  it('never closes a locked tab by a user action, but does when its file is deleted', () => {
    const { l, id } = five();
    let p = togglePin(l, id['b'] ?? '');
    p = togglePin(p, id['d'] ?? '');
    expect(closeTab(p, id['b'] ?? '')).toBe(p);
    expect(paths(closeOtherTabs(p, id['a'] ?? ''))).toEqual(['a.md', 'b.md', 'd.md']);
    expect(paths(closeAllTabs(p, p.activePane))).toEqual(['b.md', 'd.md']);
    expect(paths(closeTabsRight(p, id['a'] ?? ''))).toEqual(['a.md', 'b.md', 'd.md']);
    expect(paths(removePath(p, 'b.md'))).toEqual(['a.md', 'c.md', 'd.md', 'e.md']);
    // unlocking makes it closable again
    expect(paths(closeTab(togglePin(p, id['b'] ?? ''), id['b'] ?? ''))).not.toContain('b.md');
  });

  it('opens a note in a new tab when the active tab is locked', () => {
    let l = open(emptyLayout(), 'a.md');
    l = togglePin(l, activeTab(l)?.id ?? '');
    l = open(l, 'b.md'); // plain open would replace the active tab
    expect(paths(l)).toEqual(['a.md', 'b.md']);
    expect(activeTab(l)?.path).toBe('b.md');
  });

  it('keeps a pane with only locked tabs when closing everything, and removes an emptied one', () => {
    let l = open(open(emptyLayout(), 'a.md'), 'b.md', true);
    const first = l.activePane;
    l = togglePin(l, findPane(l, first)?.tabs[0]?.id ?? '');
    l = splitPane(l, first, 'row', 'live', 'c.md');
    expect(allPanes(l.root)).toHaveLength(2);
    expect(paths(closeAllTabs(l, first), first)).toEqual(['a.md']);
    const second = l.activePane;
    expect(allPanes(closeAllTabs(l, second).root)).toHaveLength(1);
  });

  it('persists the lock and reads layouts saved without it', () => {
    const { l, id } = five();
    const p = togglePin(l, id['c'] ?? '');
    expect(parseLayout(JSON.parse(JSON.stringify(p)))).toEqual(p);
    const tab = findPane(p, p.activePane)?.tabs.find((t) => t.id === id['c']);
    expect(tab?.pinned).toBe(true);
    expect(findPane(l, l.activePane)?.tabs.every((t) => !('pinned' in t))).toBe(true);
    expect(parseLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
    expect(togglePin(p, id['c'] ?? '')).toEqual(l);
  });
});

describe('splits', () => {
  it('splits a pane showing the same note, and closing the new pane restores the tree', () => {
    let l = open(emptyLayout(), 'a.md');
    const first = l.activePane;
    l = splitPane(l, first, 'row', 'live');
    expect(allPanes(l.root)).toHaveLength(2);
    expect(l.root.kind).toBe('split');
    expect(paths(l)).toEqual(['a.md']);
    expect(l.activePane).not.toBe(first);
    l = closePane(l, l.activePane);
    expect(l.root.kind).toBe('pane');
    expect(l.activePane).toBe(first);
  });

  it('merges nested splits of the same direction and keeps sizes normalized', () => {
    let l = open(emptyLayout(), 'a.md');
    l = splitPane(l, l.activePane, 'row', 'live');
    l = splitPane(l, l.activePane, 'row', 'live');
    expect(l.root.kind).toBe('split');
    if (l.root.kind === 'split') {
      expect(l.root.children).toHaveLength(3);
      expect(l.root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    }
    l = splitPane(l, l.activePane, 'column', 'live');
    if (l.root.kind === 'split')
      expect(l.root.children.some((c) => c.kind === 'split' && c.dir === 'column')).toBe(true);
  });

  it('resizes a split with a minimum size', () => {
    let l = open(emptyLayout(), 'a.md');
    l = splitPane(l, l.activePane, 'row', 'live');
    if (l.root.kind !== 'split') throw new Error('expected split');
    l = setSizes(l, l.root.id, [100, 0]);
    if (l.root.kind !== 'split') throw new Error('expected split');
    expect(Math.min(...l.root.sizes)).toBeGreaterThanOrEqual(0.04);
    expect(l.root.sizes.reduce((x, y) => x + y, 0)).toBeGreaterThan(0.9);
  });

  it('moves tabs between panes, removing a pane that becomes empty', () => {
    let l = open(emptyLayout(), 'a.md');
    const left = l.activePane;
    l = splitPane(l, left, 'row', 'live', 'b.md');
    const right = l.activePane;
    const moving = findPane(l, left)?.tabs[0]?.id ?? '';
    l = moveTab(l, moving, right);
    expect(allPanes(l.root)).toHaveLength(1);
    expect(paths(l).sort()).toEqual(['a.md', 'b.md']);
  });

  it('reorders tabs within a pane', () => {
    let l = open(open(open(emptyLayout(), 'a.md'), 'b.md', true), 'c.md', true);
    const pane = findPane(l, l.activePane);
    const c = pane?.tabs[2]?.id ?? '';
    l = moveTab(l, c, l.activePane, 0);
    expect(paths(l)).toEqual(['c.md', 'a.md', 'b.md']);
  });
});

describe('linked panes', () => {
  it('follow each other until unlinked', () => {
    let l = open(emptyLayout(), 'a.md');
    const p1 = l.activePane;
    l = splitPane(l, p1, 'row', 'live');
    const p2 = l.activePane;
    l = toggleLink(l, p2);
    expect(findPane(l, p1)?.link).toBeDefined();
    expect(findPane(l, p1)?.link).toBe(findPane(l, p2)?.link);
    l = open(l, 'b.md', false, p2);
    expect(paths(l, p1)).toEqual(['b.md']);
    l = toggleLink(l, p2);
    expect(findPane(l, p1)?.link).toBeUndefined();
    l = open(l, 'c.md', false, p2);
    expect(paths(l, p1)).toEqual(['b.md']);
    expect(setActivePane(l, p1).activePane).toBe(p1);
  });
});

describe('file operations', () => {
  it('follows renames of files and folders and closes tabs of deleted ones', () => {
    let l = open(open(emptyLayout(), 'Dir/a.md'), 'Dir/sub/b.md', true);
    l = renamePath(l, 'Dir', 'Moved');
    expect(paths(l)).toEqual(['Moved/a.md', 'Moved/sub/b.md']);
    l = renamePath(l, 'Moved/a.md', 'Moved/z.md');
    expect(openPaths(l)).toEqual(['Moved/z.md', 'Moved/sub/b.md']);
    l = removePath(l, 'Moved/sub');
    expect(paths(l)).toEqual(['Moved/z.md']);
  });
});

describe('persistence', () => {
  it('round-trips through JSON', () => {
    let l = open(open(emptyLayout(), 'a.md'), 'b.md', true);
    l = splitPane(l, l.activePane, 'column', 'live');
    const back = parseLayout(JSON.parse(JSON.stringify(l)));
    expect(back).toEqual(l);
  });

  it('rejects malformed layouts and repairs partial ones', () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout({ root: { kind: 'pane' } })).toBeNull();
    expect(parseLayout({ root: { kind: 'split', id: 's', dir: 'diag', children: [] } })).toBeNull();
    const repaired = parseLayout({
      activePane: 'missing',
      root: {
        kind: 'pane',
        id: 'p',
        active: 'nope',
        tabs: [
          { id: 't', path: 'a.md', mode: 'live' },
          { id: 'u', path: 'b.md', mode: 'weird' },
          5,
        ],
      },
    });
    expect(repaired?.activePane).toBe('p');
    expect(repaired && findPane(repaired, 'p')?.tabs).toHaveLength(1);
    expect(repaired && findPane(repaired, 'p')?.active).toBe('t');
  });
});
