// Pieces of a note used by embeds: a section under a heading, or the block
// carrying a ^id (![[Note#Heading]], ![[Note#^id]]).
import { extract, splitFrontmatter } from '@clarae/markdown';

/** The note without its frontmatter. */
export function stripFrontmatter(src: string): string {
  return splitFrontmatter(src).body;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[*_`=~[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Text from the heading up to the next heading of the same or a higher level. */
export function extractSection(src: string, heading: string): string | null {
  const body = stripFrontmatter(src);
  const doc = extract('', body);
  const wanted = norm(heading);
  const idx = doc.headings.findIndex((h) => norm(h.text) === wanted);
  if (idx < 0) return null;
  const h = doc.headings[idx];
  if (!h) return null;
  const lines = body.split('\n');
  const start = h.line - 1;
  let end = lines.length;
  for (const next of doc.headings.slice(idx + 1)) {
    if (next.level <= h.level) {
      end = next.line - 1;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

/** The paragraph (or list item line) that ends with ^id, without the id marker. */
export function extractBlock(src: string, id: string): string | null {
  const body = stripFrontmatter(src);
  const lines = body.split('\n');
  const marker = new RegExp(`[ \\t]\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`);
  const at = lines.findIndex((l) => marker.test(l));
  if (at < 0) return null;
  // List items and quotes are single blocks; paragraphs extend over adjacent non-blank lines.
  const isItem = /^\s*(?:[-*+]|\d+[.)]|>)/.test(lines[at] ?? '');
  let from = at;
  let to = at;
  if (!isItem) {
    const boundary = (l: string): boolean => l.trim() === '' || /^#{1,6}(\s|$)/.test(l);
    while (from > 0 && !boundary(lines[from - 1] ?? '')) from--;
    while (to + 1 < lines.length && !boundary(lines[to + 1] ?? '')) to++;
  }
  return lines
    .slice(from, to + 1)
    .map((l) => l.replace(marker, ''))
    .join('\n');
}
