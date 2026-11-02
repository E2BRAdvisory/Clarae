// The incremental block scan of Live Preview: after any edit it must equal a scan from scratch
// (checked on random documents and edits), while typing in a long note reads a few lines instead
// of the whole document.
import { describe, expect, it } from 'vitest';
import { EditorState, type ChangeSpec, type Text } from '@codemirror/state';
import { blocksField, scanDocument, scanStats, updateScan, type BlockScan } from './blockWidgets';
import { blockStates } from './blockState';

declare const process: { stderr: { write(s: string): boolean } };
const report = (...parts: unknown[]): void => void process.stderr.write(parts.join(' ') + '\n');

/** Lines that open, close or continue every construct the scanner knows. */
const VOCAB = [
  '',
  'text',
  'more text $ x',
  '$$',
  '$$ a',
  'b $$',
  '$$ x^2 $$',
  '```',
  '```mermaid',
  '```query',
  '~~~',
  '> [!note]- Title',
  '> body',
  '>',
  '---',
  '...',
  'key: value',
  '%% comment',
  'end %%',
  '    ```',
];

/** A small deterministic generator, so a failure can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

function randomDoc(r: () => number, lines: number): string {
  const out: string[] = [];
  if (r() < 0.3) out.push('---', 'a: 1', ...(r() < 0.7 ? ['---'] : []));
  while (out.length < lines) out.push(pick(r, VOCAB));
  return out.join('\n');
}

function randomChange(r: () => number, doc: Text): ChangeSpec {
  const len = doc.length;
  const at = Math.floor(r() * (len + 1));
  const roll = r();
  if (roll < 0.35) return { from: at, insert: pick(r, ['x', '$', '$$', '>', '`', '-', '\n', ' ']) };
  if (roll < 0.6) return { from: at, insert: '\n' + pick(r, VOCAB) + (r() < 0.5 ? '\n' : '') };
  if (roll < 0.85) return { from: at, to: Math.min(len, at + 1 + Math.floor(r() * 12)) };
  // Two changes at once (multiple cursors).
  const other = Math.floor(r() * (len + 1));
  const [a, b] = at <= other ? [at, other] : [other, at];
  return [
    { from: a, insert: pick(r, ['$$', '>', '```']) },
    { from: b, insert: '\n' + pick(r, VOCAB) },
  ];
}

const plain = (s: BlockScan) => ({
  blocks: s.blocks,
  units: s.units,
  fmLines: s.fmLines,
  fmOpen: s.fmOpen,
  openMath: s.openMath,
});

describe('incremental block scan', () => {
  it('always equals a scan from scratch', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      let state = EditorState.create({
        doc: randomDoc(r, 5 + Math.floor(r() * 40)),
        extensions: [blocksField, blockStates],
      });
      for (let step = 0; step < 25; step++) {
        const tr = state.update({ changes: randomChange(r, state.doc) });
        const before = state.field(blocksField);
        state = tr.state;
        const incremental = updateScan(before, tr);
        const fresh = scanDocument(state.doc);
        if (JSON.stringify(plain(incremental)) !== JSON.stringify(plain(fresh))) {
          // Show the case that broke it.
          expect({ seed, step, doc: state.doc.toString(), blocks: incremental.blocks }).toEqual({
            seed,
            step,
            doc: state.doc.toString(),
            blocks: fresh.blocks,
          });
        }
        // The field itself, and the per-line math/comment states, too.
        expect(plain(state.field(blocksField))).toEqual(plain(fresh));
        const fromScratch = EditorState.create({ doc: state.doc, extensions: [blockStates] });
        expect(state.field(blockStates)).toEqual(fromScratch.field(blockStates));
      }
    }
  });

  it('reads a few lines per keystroke in a long note, and stays linear with unclosed $$', () => {
    // About 2 MB: paragraphs, callouts, fences, display math, and lines starting with `$$`
    // that are never closed (amounts pasted from a spreadsheet).
    const chunk = [
      '---',
      'title: Long',
      '---',
      ...Array.from({ length: 2000 }, (_, i) =>
        [
          `Paragraph ${i} with some words to make the line long enough to matter here.`,
          '> [!note]- Folded',
          '> body line',
          '',
          '```js',
          'const x = 1;',
          '```',
          '$$',
          'e^{i\\pi} + 1 = 0',
          '$$',
          `$$ 1,234.${i} total`,
          'filler line with text and nothing else of interest at all, really nothing',
        ].join('\n'),
      ),
    ].join('\n');
    const text = chunk + '\n' + 'x'.repeat(80).concat('\n').repeat(30_000);
    expect(text.length).toBeGreaterThan(2_000_000);
    let state = EditorState.create({ doc: text, extensions: [blocksField, blockStates] });

    scanStats.lines = 0;
    const t0 = performance.now();
    scanDocument(state.doc);
    const full = performance.now() - t0;
    const fullLines = scanStats.lines;
    // Linear: no line is read more than twice, however many `$$` lines stay unclosed.
    expect(fullLines).toBeLessThanOrEqual(2 * state.doc.lines);

    // Typing 200 characters in the middle of the note.
    const mid = state.doc.line(Math.floor(state.doc.lines / 3)).to;
    scanStats.lines = 0;
    const t1 = performance.now();
    for (let i = 0; i < 200; i++)
      state = state.update({ changes: { from: mid + i, insert: i % 10 === 9 ? ' ' : 'a' } }).state;
    const typing = performance.now() - t1;
    const perKey = scanStats.lines / 200;
    report(
      `blockWidgets: ${state.doc.lines} lines, full scan ${full.toFixed(1)} ms / ${fullLines} lines;`,
      `200 keystrokes ${typing.toFixed(1)} ms, ${perKey.toFixed(1)} lines read per keystroke`,
    );
    expect(perKey).toBeLessThan(10);
    // Was a full scan (and a copy of the whole text) per keystroke: 200 of them took seconds.
    expect(typing).toBeLessThan(Math.max(1000, full * 20));
    expect(plain(state.field(blocksField))).toEqual(plain(scanDocument(state.doc)));
  });
});
