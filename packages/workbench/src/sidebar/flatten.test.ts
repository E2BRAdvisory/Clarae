import { describe, expect, it } from 'vitest';
import type { Entry } from '../app/api';
import { buildTree, flattenTree } from './FileExplorer';

const e = (path: string, isDir = false): Entry => ({
  path,
  name: path.split('/').pop() ?? path,
  isDir,
  kind: isDir ? 'dir' : 'note',
  size: 1,
  mtime: '2024-01-01T00:00:00Z',
});

describe('flattenTree', () => {
  const tree = buildTree([
    e('A', true),
    e('A/B', true),
    e('A/B/deep.md'),
    e('A/x.md'),
    e('top.md'),
  ]);

  it('lists rows in display order with their depth', () => {
    const rows = flattenTree(tree, new Set(['A', 'A/B']));
    expect(rows.map((r) => [r.node.entry.path, r.depth])).toEqual([
      ['A', 0],
      ['A/B', 1],
      ['A/B/deep.md', 2],
      ['A/x.md', 1],
      ['top.md', 0],
    ]);
  });

  it('hides the content of folders that are not open', () => {
    expect(flattenTree(tree, new Set(['A'])).map((r) => r.node.entry.path)).toEqual([
      'A',
      'A/B',
      'A/x.md',
      'top.md',
    ]);
    expect(flattenTree(tree, new Set()).map((r) => r.node.entry.path)).toEqual(['A', 'top.md']);
  });
});
