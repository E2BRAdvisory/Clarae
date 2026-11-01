/**
 * decodeURI that never throws: a stray '%' in a link or image path written by hand (`100%.png`,
 * `growth%2050%.png`) is a malformed escape, and an exception there would disable a CodeMirror
 * plugin or break a click handler. A path that cannot be decoded is used as written.
 */
export function safeDecodeURI(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}
