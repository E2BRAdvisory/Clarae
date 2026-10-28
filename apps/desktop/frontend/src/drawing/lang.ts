// Maps the app language ("it", "pt-BR", ...) to one of the languages Excalidraw ships.

/** Excalidraw's own code for `language`: exact match, then same primary subtag, then `en`. */
export function excalidrawLang(language: string, available: readonly string[]): string {
  const want = language.toLowerCase();
  const exact = available.find((c) => c.toLowerCase() === want);
  if (exact) return exact;
  const primary = want.split(/[-_]/)[0] ?? '';
  return available.find((c) => c.toLowerCase().split('-')[0] === primary) ?? 'en';
}
