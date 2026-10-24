import { beforeEach, describe, expect, it } from 'vitest';
import {
  allPanes,
  emptyLayout,
  openPath,
  setIdFactory,
  splitPane,
  toggleLink,
  type Layout,
} from '../workspace/layout';
import {
  captureWorkspace,
  findWorkspace,
  parseWorkspaces,
  pruneMissing,
  removeWorkspace,
  renameWorkspace,
  serializeWorkspaces,
  upsertWorkspace,
  type SidebarSnapshot,
} from './model';

const left: SidebarSnapshot = { open: true, tab: 'files', width: 280 };
const right: SidebarSnapshot = { open: false, tab: 'outline', width: 9999 };

function sample(): Layout {
  let l = openPath(emptyLayout(), 'A.md', { mode: 'live' });
  l = openPath(l, 'B.md', { mode: 'source', newTab: true });
  l = splitPane(l, l.activePane, 'row', 'live', 'C.md');
  return toggleLink(l, l.activePane);
}

describe('workspaces model', () => {
  beforeEach(() => {
    let n = 0;
    setIdFactory((p) => `${p}${++n}`);
  });

  it('captures a deep copy, normalizes the name and clamps widths', () => {
    const layout = sample();
    const ws = captureWorkspace('  My   space ', layout, left, right, 7);
    expect(ws.name).toBe('My space');
    expect(ws.right.width).toBe(600);
    expect(ws.layout).toEqual(layout);
    expect(ws.layout).not.toBe(layout);
    expect(ws.savedAt).toBe(7);
  });

  it('round-trips through the file format, keeping splits, tabs and link groups', () => {
    const layout = sample();
    const file = parseWorkspaces('');
    file.workspaces = [captureWorkspace('One', layout, left, right)];
    const back = parseWorkspaces(serializeWorkspaces(file));
    expect(back.workspaces).toHaveLength(1);
    const got = back.workspaces[0]!;
    expect(got.layout).toEqual(layout);
    expect(allPanes(got.layout.root).map((p) => p.tabs.map((t) => t.path))).toEqual([
      ['A.md', 'B.md'],
      ['C.md'],
    ]);
    expect(got.right).toEqual({ open: false, tab: 'outline', width: 600 });
  });

  it('is tolerant: bad entries dropped, duplicates ignored, unknown fields kept', () => {
    const good = captureWorkspace('Good', sample(), left, right);
    const text = JSON.stringify({
      extra: 1,
      workspaces: [
        { name: 'No layout' },
        { name: '', layout: good.layout },
        good,
        { ...good, name: 'GOOD' },
        'junk',
      ],
    });
    const file = parseWorkspaces(text);
    expect(file.workspaces.map((w) => w.name)).toEqual(['Good']);
    expect((JSON.parse(serializeWorkspaces(file)) as Record<string, unknown>)['extra']).toBe(1);
    expect(parseWorkspaces('{').workspaces).toEqual([]);
  });

  it('upserts, renames and removes by case-insensitive name', () => {
    const a = captureWorkspace('Alpha', emptyLayout(), left, right);
    const b = captureWorkspace('Beta', emptyLayout(), left, right);
    let list = upsertWorkspace(upsertWorkspace([], a), b);
    const again = captureWorkspace('alpha', sample(), left, right);
    list = upsertWorkspace(list, again);
    expect(list.map((w) => w.name)).toEqual(['Alpha', 'Beta']);
    expect(list[0]?.layout).toEqual(again.layout);

    expect(renameWorkspace(list, 'beta', 'ALPHA')).toBe('exists');
    expect(renameWorkspace(list, 'nope', 'x')).toBe('missing');
    const renamed = renameWorkspace(list, 'Beta', 'Gamma');
    expect(Array.isArray(renamed) && renamed.map((w) => w.name)).toEqual(['Alpha', 'Gamma']);
    // Changing only the case of its own name is allowed.
    const recase = renameWorkspace(list, 'Beta', 'BETA');
    expect(Array.isArray(recase) && recase[1]?.name).toBe('BETA');

    expect(removeWorkspace(list, 'ALPHA').map((w) => w.name)).toEqual(['Beta']);
    expect(findWorkspace(list, ' beta ')?.name).toBe('Beta');
  });

  it('drops tabs of files that no longer exist', () => {
    const layout = sample();
    const pruned = pruneMissing(layout, new Set(['A.md', 'C.md']));
    expect(allPanes(pruned.root).flatMap((p) => p.tabs.map((t) => t.path))).toEqual([
      'A.md',
      'C.md',
    ]);
    const none = pruneMissing(layout, new Set());
    expect(allPanes(none.root).flatMap((p) => p.tabs)).toEqual([]);
  });
});
