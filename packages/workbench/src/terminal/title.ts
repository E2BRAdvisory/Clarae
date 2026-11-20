// The title of the separate terminal window. The core gives it a fixed one when it opens the window; the page
// sets the translated one, on the page (document.title) and on the window itself where the host can.
import { WindowSetTitle } from '../../wailsjs/runtime/runtime';

export function setWindowTitle(title: string): void {
  document.title = title;
  try {
    // The Wails shim of the desktop implements it; a host without it has only the page's title.
    WindowSetTitle(title);
  } catch {
    /* no runtime for the window */
  }
}
