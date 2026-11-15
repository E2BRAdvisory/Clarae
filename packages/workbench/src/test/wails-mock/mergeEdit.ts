// VaultAPI.MergeEdit for the Wails mock: a stand-in for the core's three-way merge (shared/go/merge),
// enough for the UI to be driven. The real rules — and their tests — are the Go ones; the web
// target of the e2e matrix runs them through the WebAssembly core.

export interface MergeEditResult {
  strategy: string;
  merged: string;
  clean: boolean;
}

type Obj = Record<string, unknown>;
type Element = Obj & { id: string; version?: number; versionNonce?: number };

const NONE: MergeEditResult = { strategy: 'conflict-copy', merged: '', clean: false };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The newer of two versions of an element: higher version, then lower nonce (as the core does). */
function newer(a: Element, b: Element): Element {
  const va = a.version ?? 0;
  const vb = b.version ?? 0;
  if (va !== vb) return va > vb ? a : b;
  return (a.versionNonce ?? 0) <= (b.versionNonce ?? 0) ? a : b;
}

function excalidraw(base: string, ours: string, theirs: string): MergeEditResult {
  let b: Obj;
  let o: Obj;
  let t: Obj;
  try {
    [b, o, t] = [base, ours, theirs].map((x) => JSON.parse(x) as Obj) as [Obj, Obj, Obj];
  } catch {
    return NONE;
  }
  const list = (x: Obj): Element[] =>
    Array.isArray(x['elements']) ? (x['elements'] as Element[]) : [];
  const byId = (x: Obj) => new Map(list(x).map((e) => [e.id, e]));
  const [bm, om, tm] = [byId(b), byId(o), byId(t)];
  const order = [...list(o).map((e) => e.id), ...list(t).map((e) => e.id)];
  const elements: Element[] = [];
  for (const id of new Set(order)) {
    const [be, oe, te] = [bm.get(id), om.get(id), tm.get(id)];
    if (oe && te) elements.push(newer(oe, te));
    // on one side only: new there, or removed on the other (kept if this side changed it since)
    else if (oe && (!be || !same(be, oe))) elements.push(oe);
    else if (te && (!be || !same(be, te))) elements.push(te);
  }
  // every other key: the side that changed it since the base, ours when both did
  const merged: Obj = { ...t };
  for (const key of new Set([...Object.keys(o), ...Object.keys(t)])) {
    if (key === 'elements' || key === 'files') continue;
    merged[key] = same(o[key], b[key]) ? (t[key] ?? o[key]) : o[key];
  }
  merged['elements'] = elements;
  merged['files'] = { ...(t['files'] as Obj | undefined), ...(o['files'] as Obj | undefined) };
  return { strategy: 'excalidraw-by-id', merged: JSON.stringify(merged, null, 2), clean: true };
}

/**
 * What the mock answers. `sameAuthor` false stands for a change by another user on a shared
 * vault: only Markdown is merged then (D-04).
 */
export function mockMergeEdit(
  path: string,
  base: string,
  ours: string,
  theirs: string,
  sameAuthor: boolean,
): MergeEditResult {
  if (/\.excalidraw$/i.test(path)) return sameAuthor ? excalidraw(base, ours, theirs) : NONE;
  if (/\.md$/i.test(path)) {
    // one side unchanged: the other one; anything else is left to the real merge
    if (ours === base) return { strategy: 'markdown-3way', merged: theirs, clean: true };
    if (theirs === base) return { strategy: 'markdown-3way', merged: ours, clean: true };
    return { strategy: 'markdown-3way', merged: '', clean: false };
  }
  return NONE;
}
