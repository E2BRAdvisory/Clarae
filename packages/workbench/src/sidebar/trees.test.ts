import { describe, expect, it } from 'vitest';
import type { Entry } from '../app/api';
import { buildTree } from './FileExplorer';
import { buildTagTree } from './TagsPanel';

const e = (path: string, isDir = false, mtime = '2024-01-01T00:00:00Z'): Entry => ({
  path,
  name: path.split('/').pop() ?? path,
  isDir,
  kind: isDir ? 'dir' : 'note',
  size: 1,
  mtime,
});

describe('buildTree', () => {
  const entries = [
    e('b.md'),
    e('Notes', true),
    e('Notes/z.md', false, '2024-03-01T00:00:00Z'),
    e('Notes/a.md', false, '2024-02-01T00:00:00Z'),
    e('a.md'),
  ];

  it('puts folders first and sorts by name', () => {
    const tree = buildTree(entries);
    expect(tree.map((n) => n.entry.path)).toEqual(['Notes', 'a.md', 'b.md']);
    expect(tree[0]?.children.map((n) => n.entry.name)).toEqual(['a.md', 'z.md']);
  });

  it('sorts descending and by modification time', () => {
    expect(buildTree(entries, 'name-desc').map((n) => n.entry.path)).toEqual([
      'Notes',
      'b.md',
      'a.md',
    ]);
    expect(buildTree(entries, 'modified')[0]?.children.map((n) => n.entry.name)).toEqual([
      'z.md',
      'a.md',
    ]);
  });
});

describe('buildTagTree', () => {
  it('nests a/b under a and rolls counts up', () => {
    const tree = buildTagTree([
      { name: 'work', count: 2 },
      { name: 'work/project', count: 3 },
      { name: 'work/project/x', count: 1 },
      { name: 'life', count: 4 },
    ]);
    expect(tree.map((n) => n.full)).toEqual(['life', 'work']);
    const work = tree[1];
    expect(work?.count).toBe(6);
    expect(work?.children[0]?.full).toBe('work/project');
    expect(work?.children[0]?.children[0]?.count).toBe(1);
  });

  it('creates intermediate nodes for tags whose parent is not itself a tag', () => {
    const tree = buildTagTree([{ name: 'a/b', count: 2 }]);
    expect(tree[0]?.full).toBe('a');
    expect(tree[0]?.count).toBe(2);
    expect(tree[0]?.children[0]?.full).toBe('a/b');
  });
});
