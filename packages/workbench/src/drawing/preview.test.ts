import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../app/api';
import { installWailsMock, type WailsMock } from '../test/wails-mock';

// Excalidraw is not loaded in the tests: a stand-in that draws the number of elements.
const exportToSvg = vi.fn(
  (input: { elements: unknown[]; appState: { exportWithDarkMode?: boolean } }) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-elements', String(input.elements.length));
    return Promise.resolve(svg);
  },
);
vi.mock('./excalidraw', () => ({
  loadExcalidraw: () =>
    Promise.resolve({ restoreElements: (elements: unknown[]) => elements, exportToSvg }),
}));

import { drawingPreviewUrl, releaseDrawingPreviews } from './preview';

const scene = (n: number): string =>
  JSON.stringify({
    type: 'excalidraw',
    elements: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, type: 'frame', name: `F${i}` })),
  });

let mock: WailsMock;
let vaultId = '';
let blobs: Blob[] = [];
const reads = () => vi.mocked(api.vault.readNote).mock.calls.length;

beforeEach(async () => {
  mock = installWailsMock();
  vaultId = (await api.vault.open('/vaults/Previews')).id;
  mock.vaults.get(vaultId)?.files.set('Board.excalidraw', scene(1));
  blobs = [];
  URL.createObjectURL = (b: Blob | MediaSource) => `blob:${blobs.push(b as Blob)}`;
  URL.revokeObjectURL = () => undefined;
  vi.spyOn(api.vault, 'readNote');
  exportToSvg.mockClear();
});
afterEach(() => {
  releaseDrawingPreviews(vaultId);
  vi.restoreAllMocks();
});

describe('the preview of a drawing in an embed', () => {
  it('reads and draws a drawing that has no picture yet, and caches the picture by its hash', async () => {
    const url = await drawingPreviewUrl(vaultId, 'Board.excalidraw');
    expect(url).toMatch(/^blob:/);
    expect(reads()).toBe(1);
    expect(exportToSvg).toHaveBeenCalledTimes(1);
    const { hash } = await api.vault.readNote(vaultId, 'Board.excalidraw');
    await vi.waitFor(() => expect(mock.previews.get(hash)).toContain('data-elements="1"'));
  });

  it('does not read the drawing again while its picture is at hand', async () => {
    const first = await drawingPreviewUrl(vaultId, 'Board.excalidraw');
    vi.mocked(api.vault.readNote).mockClear();
    exportToSvg.mockClear();
    expect(await drawingPreviewUrl(vaultId, 'Board.excalidraw')).toBe(first);
    expect(reads()).toBe(0);
    expect(exportToSvg).not.toHaveBeenCalled();
  });

  it('takes the picture from the cache of the vault without reading the drawing', async () => {
    // a picture cached by an earlier session: nothing in memory, the file untouched since
    const { hash } = await api.vault.readNote(vaultId, 'Board.excalidraw');
    mock.previews.set(hash, '<svg data-from="disk"></svg>');
    vi.mocked(api.vault.readNote).mockClear();

    await drawingPreviewUrl(vaultId, 'Board.excalidraw');
    expect(reads()).toBe(0);
    expect(exportToSvg).not.toHaveBeenCalled();
    expect(await blobs[0]?.text()).toBe('<svg data-from="disk"></svg>');
  });

  it('draws once for the embeds that ask for the same drawing at the same time', async () => {
    const [a, b, c] = await Promise.all([
      drawingPreviewUrl(vaultId, 'Board.excalidraw'),
      drawingPreviewUrl(vaultId, 'Board.excalidraw'),
      drawingPreviewUrl(vaultId, 'Board.excalidraw'),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(reads()).toBe(1);
    expect(exportToSvg).toHaveBeenCalledTimes(1);
  });

  it('draws a drawing again once it changed', async () => {
    const before = await drawingPreviewUrl(vaultId, 'Board.excalidraw');
    mock.vaults.get(vaultId)?.files.set('Board.excalidraw', scene(3));
    vi.mocked(api.vault.readNote).mockClear();
    const after = await drawingPreviewUrl(vaultId, 'Board.excalidraw');
    expect(after).not.toBe(before);
    expect(reads()).toBe(1);
    expect(await blobs[blobs.length - 1]?.text()).toContain('data-elements="3"');
  });

  it('keeps the picture of a part in memory only, and still asks the core which version it is', async () => {
    const ref = { kind: 'frame' as const, value: 'F0' };
    const first = await drawingPreviewUrl(vaultId, 'Board.excalidraw', ref);
    expect(mock.previews.size).toBe(0);
    vi.mocked(api.vault.readNote).mockClear();
    expect(await drawingPreviewUrl(vaultId, 'Board.excalidraw', ref)).toBe(first);
    expect(reads()).toBe(0);
  });

  it('has a picture for each theme, cached side by side', async () => {
    const light = await drawingPreviewUrl(vaultId, 'Board.excalidraw');
    const dark = await drawingPreviewUrl(vaultId, 'Board.excalidraw', null, 'dark');
    expect(dark).not.toBe(light);
    expect(exportToSvg).toHaveBeenCalledTimes(2);
    const dims = exportToSvg.mock.calls.map((c) => c[0].appState.exportWithDarkMode);
    expect(dims).toEqual([false, true]);
    const { hash } = await api.vault.readNote(vaultId, 'Board.excalidraw');
    await vi.waitFor(() =>
      expect([...mock.previews.keys()].sort()).toEqual([hash, `${hash}.dark`]),
    );

    // Going back and forth between the themes draws nothing more, and keeps both pictures.
    exportToSvg.mockClear();
    expect(await drawingPreviewUrl(vaultId, 'Board.excalidraw')).toBe(light);
    expect(await drawingPreviewUrl(vaultId, 'Board.excalidraw', null, 'dark')).toBe(dark);
    expect(exportToSvg).not.toHaveBeenCalled();
  });

  it('fails for a drawing that is not there', async () => {
    await expect(drawingPreviewUrl(vaultId, 'Nowhere.excalidraw')).rejects.toThrow();
  });
});
