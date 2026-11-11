// How the source text of a Markdown text node relates to its value, so that a piece of the source can
// be cut out of a text node and still say what remark's own decoding says. Anything this cannot
// follow makes the caller give up (the block stays raw): it never guesses.

/** A character reference as CommonMark reads it (`&amp;`, `&#35;`, `&#x23;`). */
export const ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/** The character references of a source slice, leaving out the escaped ones (`\&amp;` is the text `&amp;`). */
export function entitiesIn(slice: string): { index: number; length: number }[] {
  const out: { index: number; length: number }[] = [];
  for (const m of slice.matchAll(ENTITY)) {
    let run = 0;
    for (let i = m.index - 1; i >= 0 && slice[i] === '\\'; i--) run++;
    if (run % 2 === 0) out.push({ index: m.index, length: m[0].length });
  }
  return out;
}

const ESCAPABLE = /[!-/:-@[-`{-~]/;

/**
 * The value of a source slice of a paragraph's text: backslash escapes resolved, the line starts
 * of continuation lines (container markers and indentation) dropped. Character references are not
 * decoded here (see `matchesValue`).
 */
export function decodeText(slice: string): string {
  return slice.replace(/\n[ \t]*(?:>[ \t]*)*/g, '\n').replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `value` can be the decoded form of `slice`: the same text with the escapes and
 * line starts resolved, and each character reference replaced by a character or two.
 */
export function matchesValue(slice: string, value: string): boolean {
  let pattern = '^';
  let last = 0;
  for (const m of entitiesIn(slice)) {
    pattern += escapeRegExp(decodeText(slice.slice(last, m.index)));
    pattern += '[\\s\\S]{1,2}';
    last = m.index + m.length;
  }
  pattern += escapeRegExp(decodeText(slice.slice(last))) + '$';
  return new RegExp(pattern, 'u').test(value);
}

/** True when `offset` (in `slice`) falls inside a backslash escape or a character reference. */
export function insideConstruct(slice: string, offset: number): boolean {
  if (offset > 0 && slice[offset - 1] === '\\' && ESCAPABLE.test(slice[offset] ?? '')) {
    // an escape only if the backslash itself is not escaped
    let run = 0;
    for (let i = offset - 1; i >= 0 && slice[i] === '\\'; i--) run++;
    if (run % 2 === 1) return true;
  }
  for (const m of entitiesIn(slice)) {
    if (offset > m.index && offset < m.index + m.length) return true;
  }
  return false;
}
