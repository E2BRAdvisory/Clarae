// Export options and what each export covers (all, the selection, one frame). Pure helpers: the
// Excalidraw calls live in render.ts.
import type { DrawingSettings } from '../settings';

export type ExportFormat = 'png' | 'svg';
export type ExportScope = { kind: 'all' } | { kind: 'selection' } | { kind: 'frame'; id: string };

export interface ExportOptions {
  format: ExportFormat;
  /** PNG scale, 1–3. */
  scale: number;
  background: boolean;
  dark: boolean;
  /** Padding around the content in px. */
  padding: number;
  /** Embed the scene in the PNG/SVG so it can be dropped back into Excalidraw. */
  embedScene: boolean;
  scope: ExportScope;
}

/** Export options the settings of the vault suggest. */
export function defaultExportOptions(
  s: Pick<DrawingSettings, 'exportScale' | 'exportPadding' | 'exportEmbedScene'>,
): ExportOptions {
  return {
    format: 'png',
    scale: s.exportScale,
    background: true,
    dark: false,
    padding: s.exportPadding,
    embedScene: s.exportEmbedScene,
    scope: { kind: 'all' },
  };
}

/** The element fields the export logic reads. */
export interface ExportEl {
  id: string;
  type: string;
  frameId?: string | null;
  containerId?: string | null;
  isDeleted?: boolean;
  name?: string | null;
}

const isFrame = (e: ExportEl): boolean => e.type === 'frame' || e.type === 'magicframe';

/** The live frames of a scene, with the name shown on the canvas ("Frame N" when unnamed). */
export function framesOf(elements: readonly ExportEl[]): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const e of elements) {
    if (e.isDeleted || !isFrame(e)) continue;
    out.push({ id: e.id, name: e.name?.trim() || `Frame ${out.length + 1}` });
  }
  return out;
}

/**
 * The elements an export covers, and the frame to clip to (frame scope only). A selection also
 * takes the labels bound to selected containers and the children of selected frames, which the
 * user does not select separately.
 */
export function scopeElements<T extends ExportEl>(
  elements: readonly T[],
  selected: readonly string[],
  scope: ExportScope,
): { elements: T[]; frame: T | null } {
  const live = elements.filter((e) => !e.isDeleted);
  if (scope.kind === 'all') return { elements: live, frame: null };
  if (scope.kind === 'frame') {
    const frame = live.find((e) => e.id === scope.id && isFrame(e)) ?? null;
    if (!frame) return { elements: [], frame: null };
    return { elements: [frame, ...live.filter((e) => e.frameId === frame.id)], frame };
  }
  const ids = new Set(selected);
  const picked = live.filter(
    (e) =>
      ids.has(e.id) ||
      (typeof e.containerId === 'string' && ids.has(e.containerId)) ||
      (typeof e.frameId === 'string' && ids.has(e.frameId)),
  );
  return { elements: picked, frame: null };
}

const slug = (s: string): string =>
  s
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '');

/** "Name.png", "Name.dark@2x.png", "Name.Slide-1.svg", "Name.selection.png". */
export function exportName(path: string, o: ExportOptions, frameName = ''): string {
  const base = (path.split('/').pop() ?? path).replace(/\.excalidraw$/i, '');
  let name = base;
  if (o.scope.kind === 'frame') name += `.${slug(frameName) || 'frame'}`;
  else if (o.scope.kind === 'selection') name += '.selection';
  if (o.dark) name += '.dark';
  if (o.format === 'png' && o.scale > 1) name += `@${o.scale}x`;
  return `${name}.${o.format}`;
}

export type AutoExport = 'none' | 'png' | 'svg' | 'both';
export type AutoExportTheme = 'light' | 'dark' | 'both';

/** What auto-export writes next to the drawing: file variants ("" = no theme marker) × formats. */
export function autoExportPlan(
  mode: AutoExport,
  theme: AutoExportTheme,
): { variant: '' | 'light' | 'dark'; format: ExportFormat }[] {
  if (mode === 'none') return [];
  const formats: ExportFormat[] = mode === 'both' ? ['png', 'svg'] : [mode];
  const variants: ('' | 'light' | 'dark')[] =
    theme === 'both' ? ['light', 'dark'] : theme === 'dark' ? ['dark'] : [''];
  return variants.flatMap((variant) => formats.map((format) => ({ variant, format })));
}
