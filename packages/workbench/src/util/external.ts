import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import { can } from '../platform';
import { isSafeExternalUrl } from './sanitize';

/**
 * Opens http(s)/mailto/tel URLs outside the app; anything else is ignored. The desktop asks the
 * system browser; the browser opens a new tab that cannot reach back into the page.
 */
export function openExternal(url: string): void {
  if (!isSafeExternalUrl(url)) return;
  if (can('nativeWindow')) BrowserOpenURL(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
