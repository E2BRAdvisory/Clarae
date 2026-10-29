// Pure helpers of the Bases UI (no React, no backend): display text of cells, sort toggling,
// column selection and embed fragments.
import type { BaseCell, BaseInfo, BaseViewInfo, SortSpec, ViewPatch } from './types';

/** `[[target|display]]` -> parts (a plain string is a target). */
export function splitLink(v: unknown): { target: string; display: string } {
  const s = typeof v === 'string' ? v : '';
  const m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(s);
  if (!m) return { target: s, display: s };
  const target = m[1] ?? '';
  return { target, display: m[2] || (target.split('/').pop() ?? target).replace(/\.md$/, '') };
}

function durationText(ms: number): string {
  const abs = Math.abs(ms);
  const units: [string, number][] = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ];
  for (const [u, size] of units)
    if (abs >= size) return `${Math.round((ms / size) * 100) / 100}${u}`;
  return `${ms}ms`;
}

/** Plain text of a cell for display and for the "title" tooltip. */
export function cellText(c: BaseCell): string {
  if (c.k === 'error') return c.e ?? 'error';
  if (c.v === undefined || c.v === null || c.k === 'null') return '';
  switch (c.k) {
    case 'list':
      return Array.isArray(c.v) ? c.v.map((x) => cellText({ k: 'text', v: x })).join(', ') : '';
    case 'link':
      return splitLink(c.v).display;
    case 'checkbox':
      return c.v === true ? '✓' : '';
    case 'duration':
      return typeof c.v === 'number' ? durationText(c.v) : '';
    case 'datetime':
      return typeof c.v === 'string' ? c.v.replace('T', ' ').replace(/:00$/, '') : '';
    default:
      return typeof c.v === 'string' || typeof c.v === 'number' ? String(c.v) : '';
  }
}

/** Index of the view named name (case-insensitive), 0 when absent or empty. */
export function viewIndexByName(info: BaseInfo, name: string): number {
  if (!name) return 0;
  const i = info.views.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());
  return i < 0 ? 0 : i;
}

/** `note.x` and `x` are the same property. */
export const sameProp = (a: string, b: string): boolean =>
  a.replace(/^note\./, '') === b.replace(/^note\./, '');

export function sortDirection(view: BaseViewInfo, colId: string): 'ASC' | 'DESC' | null {
  const s = view.sort.find((x) => sameProp(x.property, colId));
  return s ? s.direction : null;
}

/** Header click: none -> ASC -> DESC -> none; the clicked column becomes the only criterion. */
export function toggleSort(view: BaseViewInfo, colId: string): ViewPatch {
  const cur = sortDirection(view, colId);
  const next: SortSpec[] =
    cur === null
      ? [{ property: colId, direction: 'ASC' }]
      : cur === 'ASC'
        ? [{ property: colId, direction: 'DESC' }]
        : [];
  return { sort: next };
}

/** Toggles a column in the view order. */
export function toggleColumn(order: readonly string[], id: string): string[] {
  return order.some((o) => sameProp(o, id))
    ? order.filter((o) => !sameProp(o, id))
    : [...order, id];
}

/** Columns a user may add: file properties, formulas and the property keys of the vault. */
export function availableColumns(
  info: BaseInfo,
  propertyKeys: readonly string[],
): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const f of ['name', 'path', 'folder', 'ext', 'size', 'ctime', 'mtime', 'tags', 'links'])
    out.push({ id: `file.${f}`, label: `file.${f}` });
  for (const f of info.formulas) out.push({ id: `formula.${f.name}`, label: `formula.${f.name}` });
  for (const k of propertyKeys) out.push({ id: k, label: k });
  return out;
}

/** `![[x.base#View]]`: the fragment names a view. */
export const embedViewName = (heading: string): string => heading.trim();
