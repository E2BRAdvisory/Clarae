// Static rendering of a canvas (M3-WP3): an SVG picture used by `![[map.canvas]]` embeds.
// It is drawn from the data alone (no DOM measurement), so it also works for embeds that
// are rendered while the canvas editor is not open.
import { api } from '../app/api';
import { PreviewUrls } from '../embeds/previewUrls';
import {
  boundsOf,
  colorOf,
  drawOrder,
  edgeGeometry,
  parseCanvas,
  type CanvasData,
  type CNode,
} from './model';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Greedy word wrap by character count (a static picture cannot measure text). */
export function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function nodeLabel(n: CNode): string {
  switch (n.type) {
    case 'text':
      return n.text ?? '';
    case 'file':
      return (n.file ?? '').split('/').pop() ?? '';
    case 'link':
      return n.url ?? '';
    case 'group':
      return n.label ?? '';
  }
}

/** The SVG markup of a canvas. */
export function canvasSvg(data: CanvasData): string {
  const pad = 20;
  const b = boundsOf(data.nodes);
  const w = Math.max(b.width, 1) + pad * 2;
  const h = Math.max(b.height, 1) + pad * 2;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${b.x - pad} ${b.y - pad} ${w} ${h}" font-family="sans-serif" font-size="14">`,
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#888"/></marker></defs>',
    `<rect x="${b.x - pad}" y="${b.y - pad}" width="${w}" height="${h}" fill="#ffffff"/>`,
  ];
  for (const n of drawOrder(data.nodes)) {
    const stroke = colorOf(n.color) ?? (n.type === 'group' ? '#aaaaaa' : '#888888');
    const fill = n.type === 'group' ? 'none' : '#ffffff';
    out.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="6" fill="${fill}" stroke="${esc(stroke)}" stroke-width="2"/>`,
    );
    const label = nodeLabel(n);
    if (label === '') continue;
    const lines = wrap(label, Math.max(4, Math.floor((n.width - 16) / 7.5)));
    const maxLines = Math.max(1, Math.floor((n.height - 12) / 18));
    const shown = lines.slice(0, maxLines);
    if (lines.length > maxLines) shown[maxLines - 1] = `${shown[maxLines - 1] ?? ''}…`;
    const weight = n.type === 'group' ? ' font-weight="600"' : '';
    shown.forEach((l, i) =>
      out.push(
        `<text x="${n.x + 8}" y="${n.y + 22 + i * 18}" fill="#333333"${weight}>${esc(l)}</text>`,
      ),
    );
  }
  for (const e of data.edges) {
    const g = edgeGeometry(data, e);
    if (!g) continue;
    const marker = e.toEnd === 'none' ? '' : ' marker-end="url(#arrow)"';
    out.push(
      `<path d="${g.d}" fill="none" stroke="${esc(colorOf(e.color) ?? '#888888')}" stroke-width="2"${marker}/>`,
    );
    if (e.label)
      out.push(
        `<text x="${g.mid.x}" y="${g.mid.y}" text-anchor="middle" fill="#333333" stroke="#ffffff" stroke-width="4" paint-order="stroke">${esc(e.label)}</text>`,
      );
  }
  out.push('</svg>');
  return out.join('');
}

const urls = new PreviewUrls();

/** Revokes the canvas previews of a vault (it was closed). */
export function releaseCanvasPreviews(vaultId: string): void {
  urls.releaseVault(vaultId);
}

/** Blob URL of the static picture of a canvas file, for an <img>. */
export async function canvasPreviewUrl(vaultId: string, path: string): Promise<string> {
  const note = await api.vault.readNote(vaultId, path);
  const hit = urls.get(vaultId, note.hash);
  if (hit) return hit;
  return urls.put(vaultId, path, note.hash, canvasSvg(parseCanvas(note.content)));
}
