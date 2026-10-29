import { StateField, type EditorState, type Text } from '@codemirror/state';
import { scanSpans, splitFrontmatter, stripInlineCode, type BlockState } from '@memobrain/markdown';

/** Block state (inside %%comment%% / $$math$$) at the START of each line. */
export interface LineBlockState {
  inMath: boolean;
  inComment: boolean;
}

export interface DocBlockStates {
  /** Index = line number - 1. */
  lines: LineBlockState[];
  /** Number of lines taken by the frontmatter block (0 = none). */
  frontmatterLines: number;
}

function compute(doc: Text): DocBlockStates {
  const text = doc.toString();
  const fm = splitFrontmatter(text);
  const lines: LineBlockState[] = [];
  const st: BlockState = { inMath: false, inComment: false };
  for (let i = 1; i <= doc.lines; i++) {
    lines.push({ inMath: st.inMath, inComment: st.inComment });
    if (i <= fm.lines) continue;
    const line = doc.line(i).text;
    if (line.includes('%%') || line.includes('$$') || st.inMath || st.inComment) {
      scanSpans(stripInlineCode(line), st);
    }
  }
  return { lines, frontmatterLines: fm.lines };
}

/**
 * Per-line comment/math state, recomputed when the document changes. Code
 * fences are not considered here; callers skip fenced lines themselves, which
 * matches the indexer (it skips code lines before scanning).
 */
export const blockStates = StateField.define<DocBlockStates>({
  create: (state) => compute(state.doc),
  update: (value, tr) => (tr.docChanged ? compute(tr.newDoc) : value),
});

export function blockStateAt(state: EditorState, lineNumber: number): BlockState {
  const s = state.field(blockStates).lines[lineNumber - 1];
  return { inMath: s?.inMath ?? false, inComment: s?.inComment ?? false };
}
