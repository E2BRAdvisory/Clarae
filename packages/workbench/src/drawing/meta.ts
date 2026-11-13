// The product's own metadata inside an Excalidraw file, in one place: the top-level key that
// holds the per-drawing settings and the `customData` key of an element (note embeds, LaTeX,
// slides). Files written by 1.x use the legacy key; they are read as long as such files exist.
//
// Rules (ADR-0052, M17 C4):
// - reading accepts both names, the new one winning;
// - writing uses the new name only;
// - an element is migrated only when a tool rewrites it anyway (which already bumps its
//   version): rewriting every element on open or save would raise all versions and trample
//   concurrent edits in the per-id merge.

/** The key written to files. */
export const META_KEY = 'clarae';
/** Keys of earlier releases, read but never written. */
export const LEGACY_META_KEYS = ['memobrain'] as const;

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The element's metadata: the new key, else the legacy one; undefined when it has none. */
export function elementMeta(e: { customData?: unknown } | undefined | null): Rec | undefined {
  const cd = e?.customData;
  if (!isRec(cd)) return undefined;
  const own = cd[META_KEY];
  if (isRec(own)) return own;
  for (const k of LEGACY_META_KEYS) {
    const old = cd[k];
    if (isRec(old)) return old;
  }
  return undefined;
}

/**
 * The `customData` an element gets when a tool rewrites its metadata: the other keys are kept,
 * the metadata moves to the new key and the legacy keys are dropped.
 */
export function withElementMeta(customData: unknown, meta: Rec): Rec {
  const next: Rec = isRec(customData) ? { ...customData } : {};
  for (const k of LEGACY_META_KEYS) delete next[k];
  next[META_KEY] = meta;
  return next;
}

/** The per-drawing settings of a file's extra top-level keys (the new key wins over the old). */
export function fileSettingsOf(extra: Rec): Rec {
  let merged: Rec = {};
  for (const k of LEGACY_META_KEYS) if (isRec(extra[k])) merged = { ...merged, ...extra[k] };
  if (isRec(extra[META_KEY])) merged = { ...merged, ...extra[META_KEY] };
  return merged;
}

/**
 * `extra` with the settings under the new key only (the merged reading), the legacy keys
 * omitted and every other key kept. Idempotent; an empty settings object leaves no key.
 */
export function normalizeFileExtra(extra: Rec): Rec {
  const settings = fileSettingsOf(extra);
  const next: Rec = { ...extra };
  for (const k of LEGACY_META_KEYS) delete next[k];
  delete next[META_KEY];
  if (Object.keys(settings).length > 0) next[META_KEY] = settings;
  return next;
}

/** `extra` after setting (or, with `null`, clearing) one per-drawing setting. */
export function withFileSetting(extra: Rec, key: string, value: unknown): Rec {
  const settings = fileSettingsOf(extra);
  if (value === null) delete settings[key];
  else settings[key] = value;
  const next: Rec = { ...extra };
  for (const k of LEGACY_META_KEYS) delete next[k];
  delete next[META_KEY];
  if (Object.keys(settings).length > 0) next[META_KEY] = settings;
  return next;
}
