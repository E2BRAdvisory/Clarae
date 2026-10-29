import { describe, expect, it } from 'vitest';
import { diffLines, hasChanges } from './diff';

const summary = (a: string, b: string): string =>
  diffLines(a, b)
    .map((l) => (l.kind === 'same' ? '=' : l.kind === 'add' ? '+' : '-') + l.text)
    .join('|');

describe('diffLines', () => {
  it('reports identical texts as unchanged', () => {
    expect(hasChanges(diffLines('a\nb\n', 'a\nb\n'))).toBe(false);
    expect(hasChanges(diffLines('', ''))).toBe(false);
  });

  it('finds replaced, added and removed lines', () => {
    expect(summary('a\nb\nc\n', 'a\nB\nc\n')).toBe('=a|-b|+B|=c');
    expect(summary('a\nc\n', 'a\nb\nc\n')).toBe('=a|+b|=c');
    expect(summary('a\nb\nc\n', 'a\nc\n')).toBe('=a|-b|=c');
    expect(summary('', 'x\n')).toBe('+x');
    expect(summary('x\n', '')).toBe('-x');
  });

  it('numbers lines on both sides', () => {
    const d = diffLines('one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
    expect(d.find((l) => l.kind === 'del')).toMatchObject({ text: 'two', oldLine: 2 });
    expect(d.filter((l) => l.kind === 'add').map((l) => [l.text, l.newLine])).toEqual([
      ['2', 2],
      ['four', 4],
    ]);
    expect(d.at(-2)).toMatchObject({ kind: 'same', text: 'three', oldLine: 3, newLine: 3 });
  });

  it('keeps moved blocks as delete plus add rather than losing text', () => {
    const d = diffLines('a\nb\nc\nd\n', 'c\nd\na\nb\n');
    const rebuilt = d.filter((l) => l.kind !== 'del').map((l) => l.text);
    expect(rebuilt).toEqual(['c', 'd', 'a', 'b']);
  });

  it('copes with large unrelated texts', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const d = diffLines(a, b);
    expect(d.filter((l) => l.kind === 'del')).toHaveLength(3000);
    expect(d.filter((l) => l.kind === 'add')).toHaveLength(3000);
  });
});
