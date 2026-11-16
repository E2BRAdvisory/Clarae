import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_DIR, LEGACY_CONFIG_DIRS, archivePath } from './configdir';

const LEGACY = LEGACY_CONFIG_DIRS[0] as string;

describe('configuration folder names', () => {
  it('are the ones generated from shared/go/pathrules for the workbench', () => {
    const gen = readFileSync(
      new URL('../../workbench/src/platform/vaultPaths.gen.ts', import.meta.url),
      'utf8',
    );
    const dir = /CONFIG_DIR = '([^']+)'/.exec(gen)?.[1];
    const legacy = /LEGACY_CONFIG_DIRS: readonly string\[\] = \[([^\]]*)\]/
      .exec(gen)?.[1]
      ?.split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(CONFIG_DIR).toBe(dir);
    expect([...LEGACY_CONFIG_DIRS]).toEqual(legacy);
  });
});

describe('archivePath', () => {
  it.each([
    [`${LEGACY}/editor.json`, `${CONFIG_DIR}/editor.json`],
    [`${LEGACY}/templates/daily.md`, `${CONFIG_DIR}/templates/daily.md`],
    [`${CONFIG_DIR}/editor.json`, `${CONFIG_DIR}/editor.json`],
    [LEGACY, LEGACY], // the folder itself is not a settings file
    [`${LEGACY}x/editor.json`, `${LEGACY}x/editor.json`],
    [`${LEGACY}/`, `${LEGACY}/`],
    [`Notes/${LEGACY}/editor.json`, `Notes/${LEGACY}/editor.json`], // only the root folder counts
    ['notes/a.md', 'notes/a.md'],
  ])('%s -> %s', (from, to) => {
    expect(archivePath(from)).toBe(to);
  });
});
