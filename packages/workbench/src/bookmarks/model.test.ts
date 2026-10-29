import { describe, expect, it } from 'vitest';
import {
  addItem,
  fileItem,
  fileTarget,
  findExisting,
  flatten,
  getItem,
  graphItem,
  groupItem,
  groupsOf,
  itemLabel,
  moveItem,
  parseBookmarks,
  removeItem,
  renameItem,
  renamePaths,
  searchItem,
  serializeBookmarks,
  type BookmarkItem,
} from './model';

const f = (p: string, sub = ''): BookmarkItem => fileItem(p, sub, 1);
const titles = (items: BookmarkItem[]): string[] =>
  items.map((i) =>
    i.type === 'group' ? `${i.title}[${titles(i.items ?? []).join(',')}]` : itemLabel(i),
  );

describe('parse/serialize', () => {
  it('reads an Obsidian-shaped file and keeps unknown fields', () => {
    const text = JSON.stringify({
      items: [
        { type: 'file', ctime: 5, path: 'A.md', subpath: '#H', title: '', extra: 1 },
        { type: 'group', title: 'G', items: [{ type: 'search', query: 'x' }] },
        { type: 'bases', path: 'x.base' },
      ],
      other: true,
    });
    const file = parseBookmarks(text);
    expect(file.items).toHaveLength(3);
    expect(file.items[0]?.['extra']).toBe(1);
    const back = JSON.parse(serializeBookmarks(file)) as Record<string, unknown>;
    expect(back['other']).toBe(true);
    expect(back['version']).toBe(1);
    expect((back['items'] as unknown[])[2]).toEqual({ type: 'bases', path: 'x.base' });
  });

  it('drops malformed known items and survives garbage', () => {
    const file = parseBookmarks(
      JSON.stringify({
        items: [{ type: 'file' }, { type: 'search', query: 3 }, 'x', { type: 'graph' }],
      }),
    );
    expect(file.items).toEqual([{ type: 'graph', options: {} }]);
    expect(parseBookmarks('not json').items).toEqual([]);
    expect(parseBookmarks('[]').items).toEqual([]);
    expect(parseBookmarks('').items).toEqual([]);
  });
});

describe('items', () => {
  it('derives labels and targets', () => {
    expect(itemLabel(f('Notes/A.md', '#Intro'))).toBe('A > Intro');
    expect(itemLabel(f('A.md', '#^abc'))).toBe('A > ^abc');
    expect(fileTarget(f('A.md', '#^abc'))).toEqual({ path: 'A.md', heading: '', block: 'abc' });
    expect(fileTarget(f('A.md', '#Intro'))).toEqual({ path: 'A.md', heading: 'Intro', block: '' });
    expect(itemLabel({ ...searchItem('tag:#x'), title: 'Mine' })).toBe('Mine');
    expect(itemLabel(graphItem('Overview', { depth: 2 }))).toBe('Overview');
  });

  it('finds duplicates anywhere in the tree', () => {
    let items = addItem([], groupItem('G'));
    items = addItem(items, f('A.md'), [0]);
    expect(findExisting(items, f('A.md'))).toEqual([0, 0]);
    expect(findExisting(items, f('A.md', '#H'))).toBeNull();
    expect(findExisting(items, searchItem('q'))).toBeNull();
  });
});

describe('tree operations', () => {
  const base = (): BookmarkItem[] => {
    let items: BookmarkItem[] = [];
    items = addItem(items, f('a.md'));
    items = addItem(items, groupItem('G'));
    items = addItem(items, f('b.md'));
    items = addItem(items, f('c.md'), [1]);
    items = addItem(items, groupItem('H'), [1]);
    return items;
  };

  it('adds, removes and renames', () => {
    const items = base();
    expect(titles(items)).toEqual(['a', 'G[c,H[]]', 'b']);
    expect(titles(removeItem(items, [1, 0]))).toEqual(['a', 'G[H[]]', 'b']);
    expect(titles(renameItem(items, [1], 'Group'))).toEqual(['a', 'Group[c,H[]]', 'b']);
    expect(renameItem(items, [1], '  ')).toBe(items); // a group keeps its name
    expect(itemLabel(getItem(renameItem(items, [0], 'Alpha'), [0]) as BookmarkItem)).toBe('Alpha');
    expect(
      itemLabel(getItem(renameItem(renameItem(items, [0], 'Alpha'), [0], ''), [0]) as BookmarkItem),
    ).toBe('a');
    expect(addItem(items, f('z.md'), [0])).toBe(items); // not a group
  });

  it('reorders within a list', () => {
    const items = base();
    expect(titles(moveItem(items, [0], [], 3))).toEqual(['G[c,H[]]', 'b', 'a']);
    expect(titles(moveItem(items, [2], [], 0))).toEqual(['b', 'a', 'G[c,H[]]']);
    expect(titles(moveItem(items, [0], [], 1))).toEqual(['a', 'G[c,H[]]', 'b']); // no-op position
  });

  it('moves into and out of groups', () => {
    const items = base();
    expect(titles(moveItem(items, [0], [1]))).toEqual(['G[c,H[],a]', 'b']);
    // Destination path shifts when an earlier root sibling is removed.
    expect(titles(moveItem(items, [0], [1, 1], 0))).toEqual(['G[c,H[a]]', 'b']);
    expect(titles(moveItem(items, [1, 0], []))).toEqual(['a', 'G[H[]]', 'b', 'c']);
    expect(titles(moveItem(items, [2], [1, 1]))).toEqual(['a', 'G[c,H[b]]']);
  });

  it('refuses to move a group into itself or a descendant', () => {
    const items = base();
    expect(moveItem(items, [1], [1])).toBe(items);
    expect(moveItem(items, [1], [1, 1])).toBe(items);
    expect(moveItem(items, [9], [])).toBe(items);
  });

  it('follows renames and moves of files and folders', () => {
    let items = addItem([], f('Dir/a.md'));
    items = addItem(items, { type: 'folder', path: 'Dir' });
    items = addItem(items, groupItem('G'));
    items = addItem(items, f('Dir/sub/b.md', '#H'), [2]);
    items = addItem(items, f('Dirt/c.md'), [2]);
    const next = renamePaths(items, 'Dir', 'New');
    expect(next[0]?.path).toBe('New/a.md');
    expect(next[1]?.path).toBe('New');
    expect(getItem(next, [2, 0])?.path).toBe('New/sub/b.md');
    expect(getItem(next, [2, 0])?.subpath).toBe('#H');
    expect(getItem(next, [2, 1])?.path).toBe('Dirt/c.md');
    expect(renamePaths(items, 'Nope', 'X')).toBe(items);
  });

  it('flattens for pickers and lists groups', () => {
    const items = base();
    expect(flatten(items).map((x) => `${x.trail}|${itemLabel(x.item)}`)).toEqual([
      '|a',
      'G|c',
      '|b',
    ]);
    expect(groupsOf(items).map((g) => [g.title, g.depth])).toEqual([
      ['G', 0],
      ['H', 1],
    ]);
  });
});
