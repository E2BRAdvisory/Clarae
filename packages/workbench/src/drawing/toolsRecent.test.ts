import { beforeEach, describe, expect, it } from 'vitest';
import { loadRecent, saveRecent } from './ToolsPanel';

// The recently used drawing tools are remembered per vault in localStorage. 1.x kept them under
// another name: they are read from there until this release stores a list of its own.
const OLD = 'memobrain.drawing.tools.recent.v1';
const NEW = 'clarae.drawing.tools.recent.v1';

beforeEach(() => localStorage.clear());

describe('recent drawing tools', () => {
  it('start empty', () => {
    expect(loadRecent('v1')).toEqual([]);
  });

  it('are read from the key of 1.x when the new one has none', () => {
    localStorage.setItem(OLD, JSON.stringify(['drawing:a', 'drawing:b']));
    expect(loadRecent('v1')).toEqual(['drawing:a', 'drawing:b']);
  });

  it('are written to the new key, which then wins; the old one is left as it is', () => {
    localStorage.setItem(OLD, JSON.stringify(['drawing:a']));
    saveRecent('v1', 'drawing:c', loadRecent('v1'));
    expect(JSON.parse(localStorage.getItem(NEW) ?? 'null')).toEqual(['drawing:c', 'drawing:a']);
    expect(JSON.parse(localStorage.getItem(OLD) ?? 'null')).toEqual(['drawing:a']);
    saveRecent('v1', 'drawing:d', loadRecent('v1'));
    expect(loadRecent('v1')).toEqual(['drawing:d', 'drawing:c', 'drawing:a']);
  });

  it('are per vault, and a damaged value is an empty list', () => {
    localStorage.setItem(OLD, '{not json');
    expect(loadRecent('v1')).toEqual([]);
    localStorage.setItem('memobrain.drawing.tools.recent.v2', JSON.stringify(['x']));
    expect(loadRecent('v1')).toEqual([]);
  });
});
