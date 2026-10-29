import { describe, expect, it } from 'vitest';
import { normalizeLeftTab, normalizeRightTab } from '../state/store';
import { leftTabs } from './tabs';

describe('sidebar tabs', () => {
  it('shows Search only while it is the active left tab', () => {
    expect(leftTabs('files')).toEqual(['files', 'outline']);
    expect(leftTabs('search')).toEqual(['files', 'outline', 'search']);
  });

  it('maps tabs saved by older versions to the current ones', () => {
    expect(normalizeLeftTab('tags')).toBe('files');
    expect(normalizeLeftTab('bookmarks')).toBe('files');
    expect(normalizeLeftTab('outline')).toBe('outline');
    expect(normalizeRightTab('outline')).toBe('properties');
    expect(normalizeRightTab('tags')).toBe('tags');
    expect(normalizeRightTab('backlinks')).toBe('links');
    expect(normalizeRightTab('bookmarks')).toBe('links');
    expect(normalizeRightTab('stats')).toBe('stats');
    expect(normalizeRightTab(42)).toBe('properties');
  });
});
