// The envelope of a note file (A-D3): what the Live editor never sees and puts back byte for byte.
//
//   BOM + frontmatter + body (LF only) + end-of-line style
//
// The body is the Markdown the editor works on. The frontmatter is not part of the editor document,
// so it stays hidden and protected by construction (the Properties panel edits it). The end-of-line
// style is the dominant one of the file: the body is handled with LF and gets it back at the end, so a
// CRLF file is saved as CRLF (the CodeMirror editor saves it as LF today).
import { splitFrontmatter } from '@clarae/markdown';

export interface Envelope {
  /** The byte order mark (U+FEFF) or "". */
  bom: string;
  /** The frontmatter block with its delimiters and line ends (LF), "" without one. */
  frontmatter: string;
  /** The dominant line ending of the file. */
  eol: '\n' | '\r\n';
  /** True when the file has both kinds: the layer refuses it (the note opens in Source). */
  mixedEol: boolean;
  /** The Markdown body, LF only. */
  body: string;
}

const BOM = '\uFEFF';

/** Splits a file into its envelope and its body. `joinEnvelope` is the exact inverse for LF/CRLF files. */
export function splitEnvelope(raw: string): Envelope {
  let rest = raw;
  let bom = '';
  if (rest.startsWith(BOM)) {
    bom = BOM;
    rest = rest.slice(1);
  }
  const crlf = (rest.match(/\r\n/g) ?? []).length;
  const lf = (rest.match(/\n/g) ?? []).length - crlf;
  const eol: '\n' | '\r\n' = crlf > lf ? '\r\n' : '\n';
  const lfOnly = crlf > 0 ? rest.replaceAll('\r\n', '\n') : rest;
  // `splitFrontmatter` takes a mark off the text it is given: the one of this file is off already. A
  // second one is text of the body (the indexer takes off one, and sees no frontmatter behind two), and
  // it must not be dropped from the body here, or the file would not be given back as it came.
  const { body, yaml } = lfOnly.startsWith(BOM)
    ? { body: lfOnly, yaml: null }
    : splitFrontmatter(lfOnly);
  const frontmatter = yaml === null ? '' : lfOnly.slice(0, lfOnly.length - body.length);
  return { bom, frontmatter, eol, mixedEol: crlf > 0 && lf > 0, body };
}

/** The file text: BOM, frontmatter and body with the end-of-line style of the envelope. */
export function joinEnvelope(env: Envelope, body: string): string {
  const all = env.frontmatter + guardLeadingRule(env.frontmatter, body);
  return env.bom + (env.eol === '\r\n' ? all.replaceAll('\n', '\r\n') : all);
}

/**
 * A body that starts with a thematic break `---` is read back as a frontmatter by `splitFrontmatter`
 * (here and in the indexer) as soon as another `---` line follows: the file would change meaning at
 * the next reload. The first rule is then written `***`, which is the same rule in Markdown (M6).
 * Only the first line is touched, and only when the file has no frontmatter of its own.
 */
export function guardLeadingRule(frontmatter: string, body: string): string {
  if (frontmatter !== '' || !body.startsWith('---')) return body;
  if (splitFrontmatter(body).yaml === null) return body;
  const eol = body.indexOf('\n');
  const first = eol < 0 ? body : body.slice(0, eol);
  if (first.replace(/[ \t]+$/, '') !== '---') return body;
  return '***' + body.slice(first.length);
}

/**
 * A Markdown fragment inserted into the document (a template, a paste) may start with a frontmatter
 * block. That block belongs to the envelope, not to the editor: it is returned apart.
 */
export function splitInserted(md: string): { frontmatter: string; body: string } {
  const lf = md.replaceAll('\r\n', '\n');
  const { body, yaml } = splitFrontmatter(lf);
  if (yaml === null) return { frontmatter: '', body: lf };
  // `splitFrontmatter` skips a mark at the head of the fragment, and `body` is what follows the block:
  // the mark is not part of the block, which the envelope writes after a mark of its own (two marks
  // would hide the block from the indexer and from the Properties panel)
  const head = lf.startsWith(BOM) ? BOM.length : 0;
  return { frontmatter: closedFrontmatter(lf.slice(head, lf.length - body.length)), body };
}

/**
 * A frontmatter block that the body can follow: it ends with a line end (a fragment may stop at its
 * closing `---`, and the first line of the body would then be written glued to it, `---text`), and a
 * `...` closer is followed by a blank line (it closes the block for the index and for this layer, not
 * for a Markdown reader, which would read the first block of the body as a line of the block's last one).
 */
export function closedFrontmatter(frontmatter: string): string {
  if (frontmatter === '') return '';
  const closed = frontmatter.endsWith('\n') ? frontmatter : frontmatter + '\n';
  return /\n\.\.\.[ \t]*\n$/.test(closed) ? closed + '\n' : closed;
}

/**
 * The envelope after a fragment with a frontmatter was inserted at the very start of a note that has
 * none; with a frontmatter already there (or anywhere but the start) the fragment's one is kept as
 * text of the body, which is what the user pasted.
 */
export function adoptFrontmatter(
  env: Envelope,
  inserted: { frontmatter: string; body: string },
): Envelope {
  if (inserted.frontmatter === '' || env.frontmatter !== '') return env;
  return { ...env, frontmatter: inserted.frontmatter };
}

/** True when only the envelope differs between two files (same body, same line ending style). */
export function sameBody(a: Envelope, b: Envelope): boolean {
  return a.body === b.body && !a.mixedEol && !b.mixedEol;
}
