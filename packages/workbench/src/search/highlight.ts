/** A piece of a search snippet, marked when it matched the query. */
export interface SnippetPart {
  text: string;
  mark: boolean;
}

/**
 * Splits a snippet at the matched ranges the backend reports ([start, end) in UTF-16 code units,
 * the indices of JavaScript strings). Ranges out of bounds or out of order are clipped, so a stale
 * or malformed answer still renders the plain text.
 */
export function snippetParts(
  snippet: string,
  highlights: readonly (readonly number[])[] = [],
): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const r of highlights) {
    const start = Math.max(at, Math.min(r[0] ?? 0, snippet.length));
    const end = Math.max(start, Math.min(r[1] ?? 0, snippet.length));
    if (start > at) parts.push({ text: snippet.slice(at, start), mark: false });
    if (end > start) parts.push({ text: snippet.slice(start, end), mark: true });
    at = end;
  }
  if (at < snippet.length) parts.push({ text: snippet.slice(at), mark: false });
  return parts;
}
