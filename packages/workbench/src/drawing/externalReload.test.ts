import { describe, expect, it } from 'vitest';
import { documentAppState } from './externalReload';

describe('a newer version of the file in an open editor', () => {
  it('takes over the background and the grid, never the view', () => {
    expect(
      documentAppState({
        viewBackgroundColor: '#000000',
        gridSize: 20,
        gridModeEnabled: true,
        scrollX: 400,
        zoom: { value: 2 },
        selectedElementIds: { a: true },
      }),
    ).toEqual({ viewBackgroundColor: '#000000', gridSize: 20, gridModeEnabled: true });
  });

  it('leaves alone what the file does not say', () => {
    expect(documentAppState({})).toEqual({});
    expect(documentAppState({ gridSize: null })).toEqual({ gridSize: null });
  });
});
