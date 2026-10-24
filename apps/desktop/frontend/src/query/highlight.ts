// Match highlighting for result snippets: the words of the query that carry text
// (not operators, negations or property filters) are wrapped in <mark> through DOM
// nodes, never through HTML strings.

const TEXT_OPS = new Set(['file', 'path', 'content', 'line', 'block', 'section', 'task']);

/** Lower-cased words and phrases of a query worth highlighting. */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  const re = /(-?)(?:([A-Za-z-]+):)?(?:"([^"]+)"|\/([^/]+)\/|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    if (m[1] === '-' || m[4] !== undefined) continue; // negation, regex
    const op = (m[2] ?? '').toLowerCase();
    if (op && !TEXT_OPS.has(op)) continue; // tag:, task-done:, match-case: …
    let word = m[3] ?? m[5] ?? '';
    if (!op && (word === 'OR' || word.startsWith('['))) continue; // OR, [prop:value]
    word = word.replace(/^[()]+|[()]+$/g, '').trim();
    if (word) out.push(word.toLowerCase());
  }
  return [...new Set(out)];
}

/** Appends text to el, wrapping occurrences of the terms in <mark>. */
export function appendHighlighted(el: HTMLElement, text: string, terms: readonly string[]): void {
  if (terms.length === 0) {
    el.append(text);
    return;
  }
  const hay = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const t of terms) {
    for (let at = hay.indexOf(t); at >= 0; at = hay.indexOf(t, at + t.length))
      ranges.push([at, at + t.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [from, to] of ranges) {
    if (to <= pos) continue;
    const start = Math.max(from, pos);
    if (start > pos) el.append(text.slice(pos, start));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, to);
    el.append(mark);
    pos = to;
  }
  if (pos < text.length) el.append(text.slice(pos));
}
