// The host of the Excalidraw fork (zsviczian, the one behind the Obsidian plugin; ADR-0028).
//
// The fork expects the application that embeds it to register a host (`configureObsidianExcalidrawHost`):
// its text editor asks it for an inline link suggester the moment a text is edited, and throws "Obsidian
// Excalidraw host is not configured" without one. The editor then stays half open (the text hidden, no
// field to type in) and, since a text is "being edited", nothing can be dragged either. The other
// capabilities fall back to defaults when there is no host: this adapter gives exactly those, so that the
// canvas behaves as the stock Excalidraw does, and it has no suggester, no Obsidian command and no shared
// Mermaid instance of its own (Clarae converts diagrams itself: drawing/mermaid).
//
// `protocolVersion` is typed with the fork's own constant: a fork that changes the protocol stops this file
// from compiling, and excalidrawHost.test.ts compares it with the version declared by the installed package.
import type { configureObsidianExcalidrawHost } from '@excalidraw/excalidraw';

type HostAdapter = Parameters<typeof configureObsidianExcalidrawHost>[0];
/** The part of the fork this file needs (the module itself, or a stand-in in the tests). */
export interface ExcalidrawHostLib {
  configureObsidianExcalidrawHost: typeof configureObsidianExcalidrawHost;
}

/** The commands of the fork's own menus that the host runs (`runAction`). */
export type HostAction = Parameters<HostAdapter['runAction']>[0];

// The fork's own defaults (its MIN_ZOOM, MAX_ZOOM and ZOOM_STEP constants are not exported).
const ZOOM_STEP = 0.05;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;

let onAction: ((action: HostAction) => void) | null = null;

/**
 * Lets the open drawing answer the commands of the fork's menus (the LaTeX entry opens the dialog of the
 * application). Returns the function that withdraws it; a handler that was replaced meanwhile stays.
 */
export function setHostActionHandler(handler: (action: HostAction) => void): () => void {
  onAction = handler;
  return () => {
    if (onAction === handler) onAction = null;
  };
}

export function createExcalidrawHost(): HostAdapter {
  return {
    protocolVersion: 2,
    isDoubleTapEraserEnabled: () => false,
    getZoomToFitMaxLevel: () => 1,
    isPenModeCrosshairVisible: () => true,
    isSingleFingerPanningEnabled: () => false,
    isDoubleClickTextEditingDisabled: () => false,
    getZoomStep: () => ZOOM_STEP,
    getZoomMin: () => MIN_ZOOM,
    getZoomMax: () => MAX_ZOOM,
    isContextMenuDisabled: () => false,
    shouldSyncElementLinkWithText: () => true,
    // Clarae bundles the fonts (EXCALIDRAW_ASSET_PATH): nothing is read from a vault.
    loadFontFromFile: () => Promise.resolve(undefined),
    // The fork's text-to-diagram dialog and the paste of a Mermaid definition treat this as "no Mermaid
    // here" and carry on (the text is pasted as it is).
    getMermaid: () => Promise.reject(new Error('Mermaid is not provided by this host')),
    runAction: (action) => onAction?.(action),
    getLabel: (key) => key,
    // No `[[` suggestions: a plain keyboard-blocking lifecycle that never blocks.
    attachInlineLinkSuggester: () => ({ isBlockingKeys: () => false, close: () => undefined }),
  };
}

let registered: (() => void) | null = null;

/**
 * Registers the host once for the page, as soon as the fork is loaded and before anything is mounted.
 * Safe to call again (loading, mounting): the second call finds it done.
 */
export function ensureExcalidrawHost(lib: ExcalidrawHostLib): void {
  registered ??= lib.configureObsidianExcalidrawHost(createExcalidrawHost());
}

/** Forgets the registration (the tests give each case a fresh library). */
export function resetExcalidrawHost(): void {
  registered?.();
  registered = null;
  onAction = null;
}
