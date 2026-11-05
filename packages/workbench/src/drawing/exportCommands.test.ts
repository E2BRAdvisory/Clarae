import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandById, isEnabled, runCommand } from '../commands/registry';
import { useAppStore } from '../state/store';
import { emptyLayout, openPath } from '../workspace/layout';
import {
  getSceneController,
  registerSceneController,
  subscribeSceneController,
  unregisterSceneController,
  type SceneController,
} from './actions/active';

const fake = (drawingPath = 'Board.excalidraw') => {
  const openExport = vi.fn();
  const printDrawing = vi.fn(() => Promise.resolve());
  return {
    c: { openExport, printDrawing, drawingPath } as unknown as SceneController,
    openExport,
    printDrawing,
  };
};

const showTab = (path: string | null): void =>
  useAppStore.setState({
    layout: path ? openPath(emptyLayout(), path, { mode: 'source' }) : emptyLayout(),
  });

let current: SceneController | null = null;
beforeEach(() => showTab('Board.excalidraw'));
afterEach(() => {
  if (current) unregisterSceneController(current);
  current = null;
});

describe('drawing export commands (ribbon)', () => {
  const ids = ['drawing:export-png', 'drawing:export-svg', 'drawing:export-pdf'];

  it('are registered under the drawing.export feature', () => {
    for (const id of ids) expect(commandById.get(id)?.feature).toBe('drawing.export');
  });

  it('are disabled without a drawing editor and enabled with one', () => {
    for (const id of ids) expect(isEnabled(commandById.get(id)!)).toBe(false);
    current = fake().c;
    registerSceneController(current);
    for (const id of ids) expect(isEnabled(commandById.get(id)!)).toBe(true);
  });

  it('open the export dialog with the format, and print the whole drawing', async () => {
    const { c, openExport, printDrawing } = fake();
    current = c;
    registerSceneController(c);
    await runCommand('drawing:export-png');
    await runCommand('drawing:export-svg');
    await runCommand('drawing:export-pdf');
    expect(openExport).toHaveBeenNthCalledWith(1, 'png');
    expect(openExport).toHaveBeenNthCalledWith(2, 'svg');
    expect(printDrawing).toHaveBeenCalledTimes(1);
  });

  it('act only on the drawing of the active tab, not on the last editor registered', async () => {
    const { c, openExport, printDrawing } = fake('Other.excalidraw'); // another pane's drawing
    current = c;
    registerSceneController(c);
    for (const id of ids) expect(isEnabled(commandById.get(id)!)).toBe(false);
    await runCommand('drawing:export-png');
    await runCommand('drawing:export-pdf');
    expect(openExport).not.toHaveBeenCalled();
    expect(printDrawing).not.toHaveBeenCalled();
    showTab('Other.excalidraw');
    for (const id of ids) expect(isEnabled(commandById.get(id)!)).toBe(true);
  });

  it('with two drawings open (split panes) act on the one of the active tab, whichever registered last', async () => {
    const a = fake('Board.excalidraw');
    const b = fake('Other.excalidraw'); // registered after: the last one
    registerSceneController(a.c);
    registerSceneController(b.c);
    try {
      for (const id of ids) expect(isEnabled(commandById.get(id)!)).toBe(true); // Board is active
      await runCommand('drawing:export-png');
      expect(a.openExport).toHaveBeenCalledWith('png');
      expect(b.openExport).not.toHaveBeenCalled();
      expect(getSceneController()).toBe(a.c);
      expect(getSceneController('Other.excalidraw')).toBe(b.c);
      showTab('Other.excalidraw');
      await runCommand('drawing:export-svg');
      expect(b.openExport).toHaveBeenCalledWith('svg');
    } finally {
      unregisterSceneController(a.c);
      unregisterSceneController(b.c);
    }
  });

  it('keep the other drawing when one of the two goes away', () => {
    const a = fake('Board.excalidraw');
    const b = fake('Other.excalidraw');
    registerSceneController(a.c);
    registerSceneController(b.c);
    unregisterSceneController(b.c); // the pane of the last one closes
    try {
      expect(getSceneController()).toBe(a.c);
      for (const id of ids) expect(isEnabled(commandById.get(id)!)).toBe(true);
      expect(getSceneController('Other.excalidraw')).toBeNull();
    } finally {
      unregisterSceneController(a.c);
    }
    expect(getSceneController()).toBeNull();
  });

  it('tells the ribbon when a controller comes or goes', () => {
    let n = 0;
    const off = subscribeSceneController(() => n++);
    const a = fake();
    registerSceneController(a.c);
    unregisterSceneController(a.c);
    unregisterSceneController(a.c); // already gone: nothing to tell
    off();
    expect(n).toBe(2);
  });
});
