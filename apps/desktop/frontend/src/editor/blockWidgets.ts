// Multi-line Live Preview constructs: they replace whole lines, which CodeMirror
// only allows from state fields (not view plugins): hidden frontmatter, display
// math, Mermaid diagrams and foldable callouts. Blocks are scanned when the
// document changes; decorations follow the selection (a block being edited
// shows its source).
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { splitFrontmatter } from '@nodus/markdown';
import { calloutToggles, isCalloutFolded, parseCalloutHead, toggleCallout } from './callouts';
import { FrontmatterWidget, MathWidget, MermaidWidget } from './widgets';

export type BlockKind = 'frontmatter' | 'math' | 'mermaid' | 'callout';

export interface Block {
  kind: BlockKind;
  from: number;
  to: number;
  /** math: TeX; mermaid: diagram source; callout: fold marker. */
  data: string;
  /** callout: start of the title line (key of the fold state). */
  titlePos: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)/;

/** Scans the document for blocks (pure). */
export function scanBlocks(state: EditorState): Block[] {
  const doc = state.doc;
  const blocks: Block[] = [];
  const fm = splitFrontmatter(doc.toString());
  let n = 1;
  if (fm.lines > 0) {
    blocks.push({
      kind: 'frontmatter',
      from: 0,
      to: doc.line(Math.min(fm.lines, doc.lines)).to,
      data: '',
      titlePos: 0,
    });
    n = fm.lines + 1;
  }
  let fence: { char: string; len: number; lang: string; startLine: number } | null = null;
  while (n <= doc.lines) {
    const line = doc.line(n);
    const text = line.text;
    const f = FENCE.exec(text);
    if (fence) {
      if (
        f &&
        (f[1] ?? '').startsWith(fence.char) &&
        (f[1] ?? '').length >= fence.len &&
        !(f[2] ?? '')
      ) {
        if (fence.lang === 'mermaid') {
          const start = doc.line(fence.startLine);
          const code = doc.sliceString(
            doc.line(fence.startLine + 1).from <= line.from - 1
              ? doc.line(fence.startLine + 1).from
              : start.to,
            Math.max(line.from - 1, start.to),
          );
          blocks.push({
            kind: 'mermaid',
            from: start.from,
            to: line.to,
            data: n - fence.startLine > 1 ? code : '',
            titlePos: 0,
          });
        }
        fence = null;
      }
      n++;
      continue;
    }
    if (f) {
      fence = {
        char: (f[1] ?? '`').charAt(0),
        len: (f[1] ?? '').length,
        lang: (f[2] ?? '').toLowerCase(),
        startLine: n,
      };
      n++;
      continue;
    }
    const t = text.trim();
    if (t.startsWith('$$')) {
      const count = text.split('$$').length - 1;
      if (count >= 2 && t.endsWith('$$') && t.length > 4) {
        // single line: $$ x $$ alone on its line
        blocks.push({
          kind: 'math',
          from: line.from,
          to: line.to,
          data: t.slice(2, -2).trim(),
          titlePos: 0,
        });
      } else if (count === 1) {
        let m = n + 1;
        while (m <= doc.lines && !doc.line(m).text.includes('$$')) m++;
        if (m <= doc.lines) {
          const end = doc.line(m);
          const body = doc.sliceString(
            line.from + text.indexOf('$$') + 2,
            end.from + end.text.indexOf('$$'),
          );
          blocks.push({
            kind: 'math',
            from: line.from,
            to: end.to,
            data: body.trim(),
            titlePos: 0,
          });
          n = m + 1;
          continue;
        }
      }
      n++;
      continue;
    }
    if (/^\s*>/.test(text)) {
      const head = parseCalloutHead(text);
      let m = n;
      while (m + 1 <= doc.lines && /^\s*>/.test(doc.line(m + 1).text)) m++;
      if (head && head.marker !== '' && m > n) {
        blocks.push({
          kind: 'callout',
          from: line.to,
          to: doc.line(m).to,
          data: head.marker,
          titlePos: line.from,
        });
      }
      n = m + 1;
      continue;
    }
    n++;
  }
  return blocks;
}

export const blocksField = StateField.define<Block[]>({
  create: (state) => scanBlocks(state),
  update: (value, tr) => (tr.docChanged ? scanBlocks(tr.state) : value),
});

/** Decorations for the blocks, given the current selection and fold state (pure). */
export function blockDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const sel = state.selection.ranges;
  const editing = (from: number, to: number): boolean =>
    sel.some((r) => r.from <= to && r.to >= from);
  for (const b of state.field(blocksField)) {
    switch (b.kind) {
      case 'frontmatter':
        if (!editing(b.from, b.to))
          out.push(
            Decoration.replace({ widget: new FrontmatterWidget(), block: true }).range(
              b.from,
              b.to,
            ),
          );
        break;
      case 'math':
        if (!editing(b.from, b.to))
          out.push(
            Decoration.replace({ widget: new MathWidget(b.data, true), block: true }).range(
              b.from,
              b.to,
            ),
          );
        break;
      case 'mermaid':
        if (!editing(b.from, b.to) && b.data.trim())
          out.push(
            Decoration.replace({ widget: new MermaidWidget(b.data), block: true }).range(
              b.from,
              b.to,
            ),
          );
        break;
      case 'callout':
        if (isCalloutFolded(state, b.titlePos, b.data) && !editing(b.from, b.to))
          out.push(Decoration.replace({}).range(b.from, b.to));
        break;
    }
  }
  return Decoration.set(out, true);
}

const blockDecorationsField = StateField.define<DecorationSet>({
  create: (state) => blockDecorations(state),
  update: (value, tr) => {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(toggleCallout)))
      return blockDecorations(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function blockWidgets() {
  return [calloutToggles, blocksField, blockDecorationsField];
}
