import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExcalidrawHost,
  ensureExcalidrawHost,
  resetExcalidrawHost,
  setHostActionHandler,
  type ExcalidrawHostLib,
} from './excalidrawHost';

/** The version of the host protocol that the installed fork declares. */
function installedProtocolVersion(): number {
  const require = createRequire(import.meta.url);
  // .../@excalidraw/excalidraw/dist/<build>/index.js -> the package root
  const root = join(dirname(require.resolve('@excalidraw/excalidraw')), '..', '..');
  const decl = readFileSync(join(root, 'types/excalidraw/obsidianExcalidrawHost.d.ts'), 'utf8');
  const m = /OBSIDIAN_EXCALIDRAW_HOST_PROTOCOL_VERSION:\s*(\d+)/.exec(decl);
  if (!m) throw new Error('the fork no longer declares OBSIDIAN_EXCALIDRAW_HOST_PROTOCOL_VERSION');
  return Number(m[1]);
}

function fakeLib() {
  const dispose = vi.fn();
  const configure = vi.fn(() => dispose);
  const lib = { configureObsidianExcalidrawHost: configure } as unknown as ExcalidrawHostLib;
  return { lib, configure, dispose };
}

describe('the host of the Excalidraw fork', () => {
  afterEach(() => resetExcalidrawHost());

  it('speaks the protocol of the installed fork', () => {
    // A fork that moves to another protocol version must fail here, not in a user's drawing.
    expect(createExcalidrawHost().protocolVersion).toBe(installedProtocolVersion());
  });

  it('is registered once, however many times the library is loaded or mounted', () => {
    const { lib, configure } = fakeLib();
    ensureExcalidrawHost(lib);
    ensureExcalidrawHost(lib);
    expect(configure).toHaveBeenCalledTimes(1);
    const adapter = (configure.mock.calls as unknown[][])[0]?.[0] as ReturnType<
      typeof createExcalidrawHost
    >;
    expect(adapter.protocolVersion).toBe(installedProtocolVersion());
  });

  it('can be registered again after it was forgotten', () => {
    const { lib, configure, dispose } = fakeLib();
    ensureExcalidrawHost(lib);
    resetExcalidrawHost();
    expect(dispose).toHaveBeenCalledTimes(1);
    ensureExcalidrawHost(lib);
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it('gives the defaults of the stock Excalidraw', async () => {
    const h = createExcalidrawHost();
    expect(h.getZoomStep()).toBe(0.05);
    expect(h.getZoomMin()).toBe(0.1);
    expect(h.getZoomMax()).toBe(30);
    expect(h.getZoomToFitMaxLevel()).toBe(1);
    expect(h.isPenModeCrosshairVisible()).toBe(true);
    expect(h.shouldSyncElementLinkWithText()).toBe(true);
    expect(h.isContextMenuDisabled()).toBe(false);
    expect(h.isDoubleClickTextEditingDisabled()).toBe(false);
    expect(h.isDoubleTapEraserEnabled()).toBe(false);
    expect(h.isSingleFingerPanningEnabled()).toBe(false);
    expect(h.getLabel('labels.text')).toBe('labels.text');
    expect(await h.loadFontFromFile('Virgil.woff2')).toBeUndefined();
  });

  it('gives the text editor a suggester that never blocks the keys', () => {
    const s = createExcalidrawHost().attachInlineLinkSuggester(document.createElement('textarea'));
    expect(s.isBlockingKeys()).toBe(false);
    expect(() => s.close()).not.toThrow();
  });

  it('rejects the shared Mermaid instance, which the fork handles as "not available"', async () => {
    await expect(createExcalidrawHost().getMermaid()).rejects.toThrow(/not provided/);
  });

  it('runs the actions of the fork menus through the handler of the open drawing', () => {
    const h = createExcalidrawHost();
    expect(() => h.runAction('LaTeX')).not.toThrow(); // no drawing open: nothing happens
    const run = vi.fn();
    const withdraw = setHostActionHandler(run);
    h.runAction('LaTeX');
    expect(run).toHaveBeenCalledWith('LaTeX');
    // A handler replaced meanwhile is not withdrawn by the one that left.
    const next = vi.fn();
    setHostActionHandler(next);
    withdraw();
    h.runAction('card');
    expect(next).toHaveBeenCalledWith('card');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
