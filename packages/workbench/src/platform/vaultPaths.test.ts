import { describe, expect, it } from 'vitest';
import {
  CONFIG_DIR,
  LEGACY_CONFIG_DIRS,
  configFile,
  isConfigPath,
  isTrashPath,
} from './vaultPaths';

describe('vault paths', () => {
  const dirs = [CONFIG_DIR, ...LEGACY_CONFIG_DIRS];

  it('knows the configuration folder under its name and under the former ones', () => {
    expect(LEGACY_CONFIG_DIRS.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      expect(isConfigPath(dir)).toBe(true);
      expect(isConfigPath(`${dir}/bookmarks.json`)).toBe(true);
      expect(isConfigPath(`${dir}x/note.md`)).toBe(false);
      expect(isConfigPath(`Notes/${dir}/note.md`)).toBe(false);
    }
    expect(isConfigPath('Notes/a.md')).toBe(false);
  });

  it('names a configuration file wherever the vault keeps it', () => {
    for (const dir of dirs) {
      expect(configFile(`${dir}/bookmarks.json`)).toBe('bookmarks.json');
      expect(configFile(`${dir}/cache/a.png`)).toBe('cache/a.png');
      expect(configFile(dir)).toBeNull();
      expect(configFile(`${dir}/`)).toBeNull();
    }
    expect(configFile('bookmarks.json')).toBeNull();
  });

  it('knows the trash folder', () => {
    expect(isTrashPath('.trash')).toBe(true);
    expect(isTrashPath('.trash/a.md')).toBe(true);
    expect(isTrashPath('.trashed/a.md')).toBe(false);
  });
});
