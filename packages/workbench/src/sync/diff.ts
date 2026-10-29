// Line diff for the conflict and history views (longest common subsequence).
export type DiffKind = 'same' | 'add' | 'del';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line numbers in the old and new text (undefined where the line does not exist). */
  oldLine?: number;
  newLine?: number;
}

const splitLines = (s: string): string[] => {
  if (s === '') return [];
  const ls = s.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
};

/** Differences between two texts, line by line. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // Trim the common head and tail first: most edits touch a small region.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++)
    out.push({ kind: 'same', text: a[i] as string, oldLine: i + 1, newLine: i + 1 });

  // Middle part: LCS table (bounded; very large middles fall back to replace-all).
  if (am.length * bm.length > 4_000_000) {
    am.forEach((t, i) => out.push({ kind: 'del', text: t, oldLine: head + i + 1 }));
    bm.forEach((t, i) => out.push({ kind: 'add', text: t, newLine: head + i + 1 }));
  } else {
    const n = am.length;
    const m = bm.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] =
          am[i] === bm[j]
            ? (lcs[i + 1]![j + 1] as number) + 1
            : Math.max(lcs[i + 1]![j] as number, lcs[i]![j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        out.push({
          kind: 'same',
          text: am[i] as string,
          oldLine: head + i + 1,
          newLine: head + j + 1,
        });
        i++;
        j++;
      } else if ((lcs[i + 1]![j] as number) >= (lcs[i]![j + 1] as number)) {
        out.push({ kind: 'del', text: am[i] as string, oldLine: head + i + 1 });
        i++;
      } else {
        out.push({ kind: 'add', text: bm[j] as string, newLine: head + j + 1 });
        j++;
      }
    }
    for (; i < n; i++) out.push({ kind: 'del', text: am[i] as string, oldLine: head + i + 1 });
    for (; j < m; j++) out.push({ kind: 'add', text: bm[j] as string, newLine: head + j + 1 });
  }

  for (let k = 0; k < tail; k++) {
    const ai = a.length - tail + k;
    const bi = b.length - tail + k;
    out.push({ kind: 'same', text: a[ai] as string, oldLine: ai + 1, newLine: bi + 1 });
  }
  return out;
}

/** True when the texts differ. */
export const hasChanges = (lines: DiffLine[]): boolean => lines.some((l) => l.kind !== 'same');
