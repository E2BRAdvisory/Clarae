// Code-split views that survive a failed chunk download. React.lazy remembers a rejected import
// for good, so a chunk that failed once (a network hiccup, a Web UI redeployed under an open page)
// would fail forever. Here a load error is retried once on its own; if it still fails, the error
// reaches the nearest ErrorBoundary, whose "Try again" asks for a fresh import (resetFailedViews).
import { createElement, lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Wait before the automatic second attempt. */
export const RETRY_DELAY_MS = 400;

/** Messages of a dynamic import that could not be fetched, across browsers and bundlers. */
const LOAD_ERROR =
  /dynamically imported module|importing a module script failed|error loading dynamically imported|loading (css )?chunk|unable to preload css|failed to fetch/i;

/** True for the error of a code-split chunk that could not be downloaded. */
export function isChunkLoadError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'ChunkLoadError' || LOAD_ERROR.test(e.message);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs an import, once more after a short wait when the chunk could not be downloaded. */
export async function importWithRetry<T>(
  load: () => Promise<T>,
  delay = RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (!isChunkLoadError(e)) throw e;
    await sleep(delay);
    return load();
  }
}

/** The views whose import failed: a retry gives them a fresh lazy component. */
const failed = new Set<() => void>();

/** Forgets the failed imports, so the next render downloads them again. */
export function resetFailedViews(): void {
  const resets = [...failed];
  failed.clear();
  for (const reset of resets) reset();
}

/**
 * React.lazy with one automatic retry of a failed download and a reset after a final failure.
 * Render it inside a <Suspense> and an ErrorBoundary, like any lazy component.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the props of any component
export function lazyView<P extends Record<string, any>>(
  load: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> {
  let current: LazyExoticComponent<ComponentType<P>>;
  const fresh = (): void => {
    current = lazy(async () => {
      try {
        return await importWithRetry(load);
      } catch (e) {
        failed.add(fresh);
        throw e;
      }
    });
  };
  fresh();
  const View = (props: P) => createElement(current, props);
  return View;
}
