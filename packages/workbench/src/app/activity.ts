// User activity feed for the idle lock of private vaults (§3.8.2). The core owns the only lock
// timer, on both hosts, and only what the user does restarts it (background sync never does): the
// workbench reports pointer, key, wheel and touch input, at most once per window.
import { api } from './api';

/** Shortest interval between two reports (the idle timeout is counted in minutes). */
export const ACTIVITY_THROTTLE_MS = 30_000;

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * Starts reporting user activity to the core; returns the function that stops it. The first input
 * is reported at once, then at most one per `throttleMs`. Failures are ignored (no private vault,
 * a backend without the binding).
 */
export function installActivityFeed(
  throttleMs = ACTIVITY_THROTTLE_MS,
  now: () => number = () => Date.now(),
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  const onActivity = (): void => {
    const t = now();
    if (t - last < throttleMs) return;
    last = t;
    try {
      void api.crypto.activity().catch(() => undefined);
    } catch {
      // the backend is not there (yet): the next input tries again after the window
    }
  };
  // Capture phase: an editor that stops propagation still counts as activity.
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, opts);
  return () => {
    for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, opts);
  };
}
