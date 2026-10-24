import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';
import { isSafeExternalUrl } from './sanitize';

/** Opens http(s)/mailto/tel URLs in the system browser; anything else is ignored. */
export function openExternal(url: string): void {
  if (isSafeExternalUrl(url)) BrowserOpenURL(url);
}
