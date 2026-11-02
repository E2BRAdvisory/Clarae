// Shared helpers of the drawing e2e specs (on both targets, see support.ts).
import type { Page } from '@playwright/test';
import { appOrigin, expect, openVault, readVaultFile, vaultBinaries } from './support';

export interface MockWindow {
  __mock: {
    vaults: Map<
      string,
      { info: { id: string }; files: Map<string, string>; binaries: Map<string, string> }
    >;
    fileExports: { vaultId: string; name: string; mime: string; base64: string }[];
    drawingExports: Map<string, string>;
    exportCancelled: boolean;
    emit(name: string, payload: unknown): void;
  };
}

export type El = Record<string, unknown> & { id: string; type: string };

/** A complete Excalidraw element (shapes and frames; add fields through `extra`). */
export function shape(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Record<string, unknown> = {},
  type = 'rectangle',
): El {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: `a${id.length}${id}`,
    ...extra,
  };
}

export const scene = (elements: El[]): string =>
  JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'memobrain',
    elements,
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  });

/** Fails the offline gate when the page asks for anything outside the app itself. */
export function watchNetwork(page: Page): string[] {
  const external: string[] = [];
  const origin = appOrigin();
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== origin) external.push(req.url());
  });
  return external;
}

/** Opens a vault with `Board.excalidraw` holding `sceneJson`, and the drawing in a tab. */
export async function openDrawing(
  page: Page,
  sceneJson: string,
  extra: { files?: Record<string, string>; binaries?: Record<string, string> } = {},
): Promise<void> {
  await openVault(page, { 'Board.excalidraw': sceneJson, ...extra.files }, extra.binaries);
  await page.locator('.tree .node', { hasText: 'Board' }).click();
  await expect(page.locator('.drawing-canvas .excalidraw canvas.interactive')).toBeVisible({
    timeout: 60_000,
  });
}

export async function runCommand(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+p');
  const input = page.getByRole('combobox', { name: 'Type a command…' });
  await expect(input).toBeFocused();
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
}

/** Answers the prompt dialog of a command with parameters. */
export async function answerPrompt(page: Page, value: string): Promise<void> {
  const input = page.locator('#dialog-input');
  await expect(input).toBeFocused();
  await input.fill(value);
  await page.keyboard.press('Enter');
}

/** Selects everything on the canvas. */
export async function selectAll(page: Page): Promise<void> {
  const canvas = page.locator('.drawing-canvas .excalidraw canvas.interactive');
  // Excalidraw shows its shape actions once something is selected. Right after the editor mounts
  // the first Ctrl+A can be lost, so the click and the shortcut are repeated until it shows (a
  // scene with nothing to select simply ends after the last attempt).
  const selected = page.locator('.excalidraw .selected-shape-actions');
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + 4, box.y + box.height - 4); // empty corner: focuses the canvas
    await page.keyboard.press('ControlOrMeta+a');
    if (await selected.first().isVisible()) return;
    try {
      await selected.first().waitFor({ state: 'visible', timeout: 2_000 });
      return;
    } catch {
      // not selected yet: try again
    }
  }
}

export interface Saved {
  elements: (El & {
    x: number;
    y: number;
    width: number;
    height: number;
    backgroundColor?: string;
    textAlign?: string;
    customData?: { memobrain?: { kind?: string; latex?: string } };
  })[];
  files: Record<string, { mimeType: string; dataURL: string }>;
}

export const savedDrawing = async (page: Page): Promise<Saved> =>
  JSON.parse((await readVaultFile(page, 'Board.excalidraw')) || '{}') as Saved;

export const waitSaved = (page: Page) =>
  expect(page.locator('.save-state')).toHaveText('Saved', { timeout: 15_000 });

/** The vault's binary (attachment) files by path. */
export const binaries = (page: Page): Promise<Record<string, string>> => vaultBinaries(page);
