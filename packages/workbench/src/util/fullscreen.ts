// Full screen for presentations. The element Fullscreen API is tried first; the desktop web view
// does not always grant it (macOS WKWebView), so the window itself is then made full screen
// through the Wails runtime. Both are undone by `leaveFullscreen`. A browser has no window to
// control: the element Fullscreen API is all there is, and the overlay still fills the page when it
// is refused.
import {
  WindowFullscreen,
  WindowIsFullscreen,
  WindowUnfullscreen,
} from '../../wailsjs/runtime/runtime';
import { can } from '../platform';

/** True while this module put the window in full screen (so that it only undoes its own). */
let windowFull = false;

export async function enterFullscreen(el: HTMLElement): Promise<void> {
  try {
    if (el.requestFullscreen) {
      await el.requestFullscreen();
      return;
    }
  } catch {
    /* fall through to the window */
  }
  if (!can('nativeWindow')) return;
  try {
    if (await WindowIsFullscreen()) return; // already full screen: leave it as the user had it
    WindowFullscreen();
    windowFull = true;
  } catch {
    /* no Wails runtime (browser, tests): the overlay still fills the window */
  }
}

export async function leaveFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* ignore */
  }
  if (!windowFull) return;
  windowFull = false;
  try {
    WindowUnfullscreen();
  } catch {
    /* ignore */
  }
}
