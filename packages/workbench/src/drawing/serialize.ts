// The text of a drawing file beyond what Excalidraw writes: the product's own top-level keys
// (per-drawing settings) go after Excalidraw's. Pure: nothing here imports Excalidraw.
import { normalizeFileExtra } from './meta';

/**
 * `json` — an object as `JSON.stringify(value, null, 2)` writes it — with more top-level keys at
 * the end, as `JSON.stringify({ ...JSON.parse(json), ...rest }, null, 2)` would give for keys the
 * object does not have yet. The text is spliced, not parsed: a drawing with pictures is megabytes
 * of base64 and this runs on every save.
 */
export function appendRootKeys(json: string, rest: Record<string, unknown>): string {
  const entries: string[] = [];
  for (const [key, value] of Object.entries(rest)) {
    const text = JSON.stringify(value, null, 2) as string | undefined;
    // JSON.stringify leaves out what has no JSON form
    if (text !== undefined)
      entries.push(`  ${JSON.stringify(key)}: ${text.replace(/\n/g, '\n  ')}`);
  }
  if (entries.length === 0) return json;
  // Anything but the two-space layout takes the slow, certain way.
  if (!json.startsWith('{\n') || !json.endsWith('\n}'))
    return JSON.stringify({ ...(JSON.parse(json) as object), ...rest }, null, 2);
  return `${json.slice(0, -2)},\n${entries.join(',\n')}\n}`;
}

/**
 * The file text of a scene: Excalidraw's JSON plus the extra top-level keys of the file, with the
 * settings under the current key only (a 1.x file keeps its legacy one until it is saved).
 */
export function withFileExtra(json: string, extra: Record<string, unknown>): string {
  return appendRootKeys(json, normalizeFileExtra(extra));
}
