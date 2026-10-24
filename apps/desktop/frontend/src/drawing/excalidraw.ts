// Loads Excalidraw lazily and points it at the fonts bundled with the app, so a drawing
// opens with no network at all (vite serves and copies them: see vite.config.ts).

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

export const ASSET_PATH = '/excalidraw-assets/';

export function configureExcalidrawAssets(): void {
  window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;
}

type ExcalidrawModule = Awaited<ReturnType<typeof importExcalidraw>>;
const importExcalidraw = () => import('@excalidraw/excalidraw');
let loaded: Promise<ExcalidrawModule> | undefined;

/** The Excalidraw module, loaded once and only when a drawing is first needed. */
export function loadExcalidraw(): Promise<ExcalidrawModule> {
  configureExcalidrawAssets();
  loaded ??= importExcalidraw();
  return loaded;
}
