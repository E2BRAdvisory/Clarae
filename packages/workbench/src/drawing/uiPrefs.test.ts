import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.restoreAllMocks();
});

const load = async () => (await import('./uiPrefs')).useDrawingUi;

describe('what a drawing editor shows, per device', () => {
  it('hides the mini-map until the user asks for it, and remembers the choice', async () => {
    let ui = await load();
    expect(ui.getState().minimap).toBe(false);
    ui.getState().toggleMinimap();
    expect(ui.getState().minimap).toBe(true);
    expect(localStorage.getItem('clarae.drawing.minimap')).toBe('1');

    vi.resetModules();
    ui = await load();
    expect(ui.getState().minimap).toBe(true);
    ui.getState().toggleMinimap();
    expect(localStorage.getItem('clarae.drawing.minimap')).toBe('0');
  });

  it('keeps the choice for the session when the storage is not available', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const ui = await load();
    ui.getState().toggleMinimap();
    expect(ui.getState().minimap).toBe(true);
  });
});
