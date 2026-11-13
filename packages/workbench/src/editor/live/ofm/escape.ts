// The escape invariant (B2): what `extract()` finds in a serialized block is what the editor document
// has there, no more and no less.
//
// The OFM constructs of the document are nodes and marks that are written verbatim (nodes.ts). A text
// node is plain text, and plain text that LOOKS like a construct must not become one when it is
// written: `[[x]]` typed as text would turn into a backlink, `#tag` into a tag, a trailing ` ^id`
// into a block id, `%%` into a comment that hides the rest of the line. The Markdown serializer's own
// escaping already stops `[[x]]` and `^[x]` (it escapes every `[`); this adds the rest, and takes
// back the escape of the few `[` forms the file legitimately starts with (`[!note]`, `[/]`).
//
// What counts as a construct is decided by `scanInline`, the scanner of the indexer, applied to the
// output: there is no second set of rules here.
import { scanInline } from '@clarae/markdown';

interface Info {
  before: string;
  after: string;
}

interface TextNode {
  value: string;
}

interface State {
  safe(value: string, info: Info & { encode: string[] }): string;
  /** The constructs being written, the innermost last (`headingAtx` in a heading). */
  stack?: string[];
}

/** `\[!note]` and `\[/]` at the start of a block are written as the file has them. */
function restoreBracketForms(out: string, before: string): string {
  const prev = before.slice(-1);
  if (prev !== '' && prev !== '\n') return out;
  return out.replace(/^\\\[(!\w[\w-]*\](?=[+-]?(?:\s|$))|[^\]\s]\](?=\s|$))/, '[$1');
}

/** `token` becomes `escaped` where it is not itself escaped: a `\\` before it escapes it only if the run of them is odd. */
function escapeUnescaped(text: string, token: string, escaped: string): string {
  let out = '';
  let last = 0;
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, last)) {
    let run = 0;
    for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) run++;
    out += text.slice(last, at) + (run % 2 === 1 ? token : escaped);
    last = at + token.length;
  }
  return out + text.slice(last);
}

/**
 * The escapes of the Markdown serializer, turned into the form that both the indexer and the Reading
 * view read as text: `\[[x]]` (the first bracket only, never `\[\[x]]`, which Reading would read as a
 * link; and only where a `]]` closes it, as the index reads) and `\^[x]` (Reading reads an inline
 * footnote from `^\[`), then the escapes of the OFM invariant.
 */
export function escapeOfmText(safe: string, before: string, after: string): string {
  // `\^[` first: the bracket of `^\[` is taken by it, so a `[[x]]` after it stays escaped on its own
  let text = restoreBracketForms(safe, before)
    .replace(/\^\\\[/g, '\\^[')
    .replace(/\\\[\\\[(?=[^[\]\n]+?\]\])/g, '\\[[');
  // a heading that ends in `#` (`# C#`): the serializer escapes it as if it were a closing sequence
  if (after === '' || after === '\n') text = text.replace(/(?<=[^\s\\])\\#$/, '#');
  text = escapeUnescaped(escapeUnescaped(text, '%%', '\\%\\%'), '$$', '\\$\\$');

  // what the index sees before this text: a link, a comment, a math span or a code span just before
  // it is blanked out there, so a `#tag` or `^id` that follows one has a boundary
  const last = before.slice(-1);
  const lead = '])%$`'.includes(last) && last !== '' ? ' ' : last;
  const probe = lead + text;
  const spans = scanInline(probe, { inMath: false, inComment: false });
  const cuts: number[] = [];
  for (const s of spans) {
    if (s.from < lead.length) continue;
    if (s.kind === 'tag')
      cuts.push(s.from); // the "#"
    else if (s.kind === 'blockId' && s.to === probe.length && (after === '' || after === '\n')) {
      cuts.push(s.from); // the "^"
    }
  }
  for (const at of cuts.sort((x, y) => y - x)) {
    const i = at - lead.length;
    text = text.slice(0, i) + '\\' + text.slice(i);
  }
  return text;
}

/**
 * The `text` handler of remark-stringify. Milkdown's own returns, unescaped, any text that ends in
 * a space and has no `*`, `_` or `\`: it is not used. Whitespace alone is written as it is.
 */
export function liveTextHandler(
  node: TextNode,
  _parent: unknown,
  state: State,
  info: Info,
): string {
  if (/^\s+$/.test(node.value)) {
    // blanks that open a block that goes on after them (`    [[a]] text`) are an indented code block
    // for Markdown, to which the link and the tag are text: the first one is a character reference, as
    // it is for the blanks that open a block of plain text
    const startsBlock = (info.before ?? '') === '' || info.before.endsWith('\n');
    return startsBlock && !endsBlock(info.after ?? '') ? encodeFirstBlank(node.value) : node.value;
  }
  const encoded = state.safe(node.value, { ...info, encode: [] });
  // before the escapes: the head of a callout is `[!note] ` only with the blank in place
  const safe = endsBlock(info.after ?? '') ? literalTrailingBlanks(node.value, encoded) : encoded;
  const text = escapeOfmText(safe, info.before ?? '', info.after ?? '');
  return state.stack?.some((c) => c.startsWith('heading')) ? unescapeInHeading(text) : text;
}

/**
 * The index keeps the text of a heading as the file has it, backslashes included: `# a\[^1]` is a heading
 * of that name, not of `a[^1]`, so a heading that was `# a[^1]` (no definition: it is text) would not be the
 * same note once written again, and the editor would keep it raw. In a heading the two escapes of the
 * serializer that do not stop anything (a footnote label with no definition, a `://` that no link reads
 * after a word) are not written.
 */
function unescapeInHeading(text: string): string {
  return text.replace(/\\(?=\[\^[^\]\s]+\](?!:))/g, '').replace(/(?<=[ps])\\:(?=\/)/g, ':');
}

/** `value` with its first space or tab as a character reference (the rest of the blanks are as they are). */
function encodeFirstBlank(value: string): string {
  const first = value[0];
  if (first === ' ') return '&#x20;' + value.slice(1);
  if (first === '\t') return '&#x9;' + value.slice(1);
  return value;
}

/** Whether what follows a text is the end of its block (its line end or nothing). */
const endsBlock = (after: string): boolean => after === '' || after === '\n';

/**
 * The blanks that end a text at the end of a block are written as they are, not as the character
 * references (`&#x20;`) of the serializer: Source writes them so, and a callout head `[!note] ` or a
 * line typed up to a space is not worth a rewrite of bytes the user did not mean. The blanks of the text
 * are read back as one with the paragraph (a block does not end with blanks), which the session sees as
 * the same document.
 */
function literalTrailingBlanks(value: string, out: string): string {
  const blanks = /[ \t]+$/.exec(value)?.[0];
  if (!blanks) return out;
  const encoded = [...blanks].map((c) => (c === '\t' ? '&#x9;' : '&#x20;')).join('');
  return out.endsWith(encoded) ? out.slice(0, out.length - encoded.length) + blanks : out;
}
