import { beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../app/api';
import { hashOf, installWailsMock } from '.';

// The property writer of the mock keeps a leading BOM first, like apps/desktop/internal/properties: the block
// is edited behind it, never duplicated in front of it.
const BOM = '﻿';
let vaultId = '';
let files = new Map<string, string>();

beforeAll(async () => {
  const mock = installWailsMock();
  vaultId = (await api.vault.open('/vaults/Props')).id;
  const v = mock.vaults.get(vaultId);
  if (!v) throw new Error('no mock vault');
  files = v.files;
});

describe('properties of the Wails mock behind a BOM', () => {
  it('updates a key in place and keeps the BOM first', async () => {
    const src = `${BOM}---\na: 1\nb: 2\n---\n# H\n`;
    files.set('n.md', src);
    await api.properties.update(vaultId, 'n.md', 'a', 5, hashOf(src));
    expect(files.get('n.md')).toBe(`${BOM}---\na: 5\nb: 2\n---\n# H\n`);
  });

  it('removes a key and keeps the BOM first', async () => {
    const src = `${BOM}---\na: 1\nb: 2\n---\n# H\n`;
    files.set('d.md', src);
    await api.properties.remove(vaultId, 'd.md', 'a', hashOf(src));
    expect(files.get('d.md')).toBe(`${BOM}---\nb: 2\n---\n# H\n`);
  });

  it('removing the last key drops the block and keeps the BOM', async () => {
    const src = `${BOM}---\na: 1\n---\n# H\n`;
    files.set('l.md', src);
    await api.properties.remove(vaultId, 'l.md', 'a', hashOf(src));
    expect(files.get('l.md')).toBe(`${BOM}# H\n`);
  });

  it('creates the block after the BOM', async () => {
    const src = `${BOM}# H\n`;
    files.set('c.md', src);
    await api.properties.update(vaultId, 'c.md', 'a', 1, hashOf(src));
    expect(files.get('c.md')).toBe(`${BOM}---\na: 1\n---\n# H\n`);
  });

  it('leaves a note without a BOM without one', async () => {
    const src = '---\na: 1\n---\n# H\n';
    files.set('p.md', src);
    await api.properties.update(vaultId, 'p.md', 'a', 2, hashOf(src));
    expect(files.get('p.md')).toBe('---\na: 2\n---\n# H\n');
  });
});
