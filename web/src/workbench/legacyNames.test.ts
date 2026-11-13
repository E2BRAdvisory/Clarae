import { describe, expect, it } from 'vitest';
import {
  LEGACY_ACCOUNT_SALT,
  LEGACY_DATA_ROOT,
  LEGACY_DEVICE_DB,
  LEGACY_LANG_KEY,
  LEGACY_MARKERS_KEY,
  LEGACY_SCRATCH_DIRS,
  LEGACY_THEME_KEY,
  LEGACY_WORKBENCH_CHANNEL,
  LEGACY_WORKBENCH_LOCK,
} from './legacyNames';
import { accountKey, legacyAccountKey } from './storage';

// A profile of the browser holds its data under these names. They are what 1.4 wrote: a rename of the
// product must not reach them, or the data of every existing profile would be left behind.
describe('names of 1.4', () => {
  it('are the ones 1.4 used', () => {
    expect(LEGACY_ACCOUNT_SALT).toBe('memobrain/workbench-account');
    expect(LEGACY_DATA_ROOT).toBe('memobrain');
    expect(LEGACY_DEVICE_DB).toBe('memobrain-device');
    expect(LEGACY_MARKERS_KEY).toBe('memobrain.workbench.vaults');
    expect(LEGACY_WORKBENCH_LOCK).toBe('memobrain-workbench');
    expect(LEGACY_WORKBENCH_CHANNEL).toBe('memobrain-workbench');
    expect(LEGACY_SCRATCH_DIRS).toEqual(['/tmp/memobrain-downloads', '/tmp/memobrain-uploads']);
    expect(LEGACY_THEME_KEY).toBe('memobrain.web.theme');
    expect(LEGACY_LANG_KEY).toBe('memobrain.web.lang');
  });

  it('derive the account folder 1.4 created, and the new key is another one', async () => {
    const a = { server: 'https://notes.example', subject: 'alice' };
    // sha256("<salt>\nhttps://notes.example\nalice"), first 16 bytes, as 1.4 computed it.
    expect(await legacyAccountKey(a)).toBe('a6d56d37d0d31f9308fe9116dbb678cdd');
    expect(await accountKey(a)).toBe('a895c41e029138ebeae619563ad68f3ce');
  });
});
