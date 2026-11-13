// The incremental per-line block state of Source (inside %%comment%% / $$math$$): after any edit it must
// equal the state computed from scratch (checked on random documents and edits), while typing in a long
// note rescans a few lines instead of the whole document. And the frontmatter, as splitFrontmatter has it.
import { describe, expect, it } from 'vitest';
import { EditorState, Text, type ChangeSpec } from '@codemirror/state';
import { splitFrontmatter } from '@clarae/markdown';
import { blockStates, frontmatterOf } from './blockState';

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

describe('incremental block state', () => {
  it('always equals the state from scratch', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      let state = EditorState.create({
        doc: randomDoc(r, 5 + Math.floor(r() * 40)),
        extensions: [blockStates],
      });
      for (let step = 0; step < 25; step++) {
        state = state.update({ changes: randomChange(r, state.doc) }).state;
        const fromScratch = EditorState.create({ doc: state.doc, extensions: [blockStates] });
        expect(state.field(blockStates)).toEqual(fromScratch.field(blockStates));
      }
    }
  });

  it('costs a few lines per keystroke in a long note, not the whole document', () => {
    // About 2 MB: paragraphs, callouts, fences, display math, and lines starting with `$$` that are never
    // closed (amounts pasted from a spreadsheet).
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
          '%% a comment that %% closes on its line',
        ].join('\n'),
      ),
    ].join('\n');
    const text = chunk + '\n' + 'x'.repeat(80).concat('\n').repeat(30_000);
    expect(text.length).toBeGreaterThan(2_000_000);
    const t0 = performance.now();
    let state = EditorState.create({ doc: text, extensions: [blockStates] });
    const full = performance.now() - t0;
    // Typing 200 characters in the middle of the note.
    const mid = state.doc.line(Math.floor(state.doc.lines / 3)).to;
    const t1 = performance.now();
    for (let i = 0; i < 200; i++)
      state = state.update({ changes: { from: mid + i, insert: i % 10 === 9 ? ' ' : 'a' } }).state;
    const typing = performance.now() - t1;
    // A state from scratch per keystroke would be 200 full scans
    expect(typing).toBeLessThan(Math.max(1000, full * 20));
    expect(state.field(blockStates)).toEqual(
      EditorState.create({ doc: state.doc, extensions: [blockStates] }).field(blockStates),
    );
  });
});

describe('frontmatterOf', () => {
  const NOTES = [
    '---\na: 1\n---\nbody\n',
    '\uFEFF---\na: 1\n---\nbody\n',
    '\uFEFF---\r\na: 1\r\n...\r\nbody\r\n',
    '\uFEFF\uFEFF---\na: 1\n---\nbody\n',
    '\uFEFF---\na: 1\nbody\n',
    '\uFEFFplain\n---\n',
    '\uFEFF',
    '---',
    '',
  ];
  it.each(NOTES)('answers as splitFrontmatter does on %j, a BOM included', (raw) => {
    const fm = splitFrontmatter(raw);
    const mine = frontmatterOf(Text.of(raw.split('\n')));
    expect(mine.lines).toBe(fm.lines);
    // an open block is one that `splitFrontmatter` does not close, with a first line that opens it
    const first = (raw.split('\n')[0] ?? '').replace(/^\uFEFF/, '').replace(/\r+$/, '');
    expect(mine.open).toBe(fm.yaml === null && raw.includes('\n') && first === '---');
  });
});
