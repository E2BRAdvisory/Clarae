import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Entry } from './api';
import type { FileChange } from './events';
import {
  applyVaultChanges,
  COALESCE_MS,
  onVaultChanges,
  staleTargets,
  type VaultChangeBatch,
} from './fileChanges';
import { installWailsMock, type WailsMock } from '../test/wails-mock';

const file = (path: string, size = 1, mtime = 't0'): Entry => ({
  path,
  name: path.split('/').pop() ?? path,
  isDir: false,
  kind: path.endsWith('.md') ? 'md' : 'other',
  size,
  mtime,
});
const dir = (path: string): Entry => ({ ...file(path, 0), isDir: true, kind: '' });
const batch = (changes: FileChange[], unknown = false): VaultChangeBatch => ({
  vaultId: 'v',
  changes,
  unknown,
  paths: changes.map((c) => c.path),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('onVaultChanges', () => {
  let mock: WailsMock;
  beforeEach(() => {
    mock = installWailsMock();
  });

  it('delivers a burst as one batch with the net change of each path', async () => {
    const got: VaultChangeBatch[] = [];
    const off = onVaultChanges((b) => got.push(b));
    const e = file('a.md');
    mock.emit('vault:file-changed', {
      vaultId: 'v',
      paths: ['a.md'],
      changes: [{ type: 'create', path: 'a.md', entry: e }],
    });
    mock.emit('vault:file-changed', {
      vaultId: 'v',
      paths: ['a.md', 'b.md'],
      changes: [
        { type: 'modify', path: 'a.md', entry: { ...e, size: 2 } },
        { type: 'delete', path: 'b.md' },
      ],
    });
    mock.emit('vault:file-changed', {
      vaultId: 'v',
      paths: ['c.md'],
      changes: [{ type: 'rename', from: 'old.md', path: 'c.md', entry: file('c.md') }],
    });
    expect(got).toHaveLength(0);
    await sleep(COALESCE_MS + 20);
    expect(got).toHaveLength(1);
    const types = Object.fromEntries((got[0]?.changes ?? []).map((c) => [c.path, c.type]));
    expect(types).toEqual({
      'a.md': 'create',
      'b.md': 'delete',
      'old.md': 'delete',
      'c.md': 'create',
    });
    expect(got[0]?.changes.find((c) => c.path === 'a.md')?.entry?.size).toBe(2);
    expect(got[0]?.unknown).toBe(false);
    off();
    expect(mock.listeners('vault:file-changed')).toBe(0);
  });

  it('marks batches from a core that sends only paths as unknown', async () => {
    const got: VaultChangeBatch[] = [];
    const off = onVaultChanges((b) => got.push(b));
    mock.emit('vault:file-changed', { vaultId: 'v', paths: ['a.md'] });
    await sleep(COALESCE_MS + 20);
    expect(got[0]).toMatchObject({ unknown: true, paths: ['a.md'] });
    off();
  });
});

describe('applyVaultChanges', () => {
  let qc: QueryClient;
  let invalidated: string[];
  beforeEach(() => {
    qc = new QueryClient();
    invalidated = [];
    vi.spyOn(qc, 'invalidateQueries').mockImplementation((f) => {
      invalidated.push(JSON.stringify(f?.queryKey));
      return Promise.resolve();
    });
    qc.setQueryData(
      ['tree', 'v'],
      [dir('Notes'), file('Notes/a.md'), file('b.md'), file('pic.png'), dir('.clarae')],
    );
  });
  const tree = () => (qc.getQueryData<Entry[]>(['tree', 'v']) ?? []).map((e) => e.path);

  it('patches size and mtime of an edited note and invalidates only content queries', () => {
    applyVaultChanges(qc, batch([{ type: 'modify', path: 'b.md', entry: file('b.md', 9, 't1') }]));
    expect(qc.getQueryData<Entry[]>(['tree', 'v'])?.find((e) => e.path === 'b.md')).toMatchObject({
      size: 9,
      mtime: 't1',
    });
    expect(invalidated).not.toContain('["tree","v"]');
    expect(invalidated).toEqual(
      expect.arrayContaining([
        '["search","v"]',
        '["backlinks","v"]',
        '["tags","v"]',
        '["propkeys","v"]',
        '["outline","v","b.md"]',
      ]),
    );
  });

  it('keeps the tree as it is when nothing it shows changed', () => {
    const before = qc.getQueryData(['tree', 'v']);
    applyVaultChanges(qc, batch([{ type: 'modify', path: 'b.md', entry: file('b.md') }]));
    expect(qc.getQueryData(['tree', 'v'])).toBe(before);
  });

  it('ignores edits of attachments and vault settings for the index views', () => {
    applyVaultChanges(
      qc,
      batch([
        { type: 'modify', path: 'pic.png', entry: file('pic.png', 5) },
        {
          type: 'modify',
          path: '.clarae/bookmarks.json',
          entry: file('.clarae/bookmarks.json'),
        },
      ]),
    );
    expect(invalidated).toEqual([]);
  });

  it('adds created files and removes deleted ones (folders with their contents)', () => {
    applyVaultChanges(
      qc,
      batch([
        { type: 'create', path: 'Notes/c.md', entry: file('Notes/c.md') },
        { type: 'delete', path: 'b.md' },
      ]),
    );
    expect(tree()).toEqual(['Notes', 'Notes/a.md', 'pic.png', '.clarae', 'Notes/c.md']);
    applyVaultChanges(qc, batch([{ type: 'delete', path: 'Notes' }]));
    expect(tree()).toEqual(['pic.png', '.clarae']);
    expect(invalidated).not.toContain('["tree","v"]');
  });

  it('reloads the tree for a new folder or a file in an unknown folder', () => {
    applyVaultChanges(qc, batch([{ type: 'create', path: 'New', entry: dir('New') }]));
    expect(invalidated).toContain('["tree","v"]');
    invalidated = [];
    applyVaultChanges(qc, batch([{ type: 'create', path: 'X/y.md', entry: file('X/y.md') }]));
    expect(invalidated).toContain('["tree","v"]');
  });

  it('falls back to invalidating everything for an unknown batch', () => {
    applyVaultChanges(qc, batch([], true));
    expect(invalidated).toEqual(
      expect.arrayContaining(['["tree","v"]', '["search","v"]', '["backlinks","v"]']),
    );
  });
});

describe('staleTargets', () => {
  const cache = new Map([
    ['A', 'A.md'],
    ['Folder/B', 'Folder/B.md'],
    ['Ghost', ''],
    ['C', 'Deep/C.md'],
  ]);

  it('re-checks the links of a deleted file or folder', () => {
    expect(staleTargets(cache, batch([{ type: 'delete', path: 'A.md' }]))).toEqual(['A']);
    expect(staleTargets(cache, batch([{ type: 'delete', path: 'Folder' }]))).toEqual(['Folder/B']);
  });

  it('re-checks unresolved links and links named like a created file', () => {
    expect(
      staleTargets(cache, batch([{ type: 'create', path: 'C.md', entry: file('C.md') }])),
    ).toEqual(['Ghost', 'C']);
  });

  it('re-checks unresolved links and links to a note whose aliases may have changed', () => {
    expect(
      staleTargets(cache, batch([{ type: 'modify', path: 'A.md', entry: file('A.md') }])),
    ).toEqual(['A', 'Ghost']);
    expect(
      staleTargets(cache, batch([{ type: 'modify', path: 'pic.png', entry: file('pic.png') }])),
    ).toEqual([]);
  });

  it('gives up on targets for new folders and unknown batches', () => {
    expect(staleTargets(cache, batch([{ type: 'create', path: 'D', entry: dir('D') }]))).toBeNull();
    expect(staleTargets(cache, batch([], true))).toBeNull();
  });
});
