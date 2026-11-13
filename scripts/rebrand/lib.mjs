// Rules of the rebrand from "MemoBrain Notes" to "Clarae notanda" (ADR-0052): what is renamed, and
// what is allowed to keep the old name. Used by rename.mjs (the one-off mechanical pass) and by
// check.mjs (the permanent guard in `task lint`), so both read the allowlist the same way.

/** The old name, in any casing. */
export const OLD = /memobrain/gi;

// Ordered: the product name first, then each casing of the identifier. Case-sensitive on purpose,
// a casing that is not listed is left alone and reported by the guard.
const RULES = [
  [/MemoBrain([ -]|\\ )Notes/g, 'Clarae$1notanda'],
  [/MemoBrain/g, 'Clarae'],
  [/Memobrain/g, 'Clarae'],
  [/MEMOBRAIN/g, 'CLARAE'],
  [/memobrain/g, 'clarae'],
];

/** renameText applies the rename to a piece of text that has no allowed occurrence in it. */
export function renameText(s) {
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}

/**
 * parseAllowlist reads allowlist.tsv: `class <TAB> glob <TAB> regex <TAB> reason`, '#' comments.
 * The regex is a JavaScript source matched against one line (case-sensitive): an occurrence of the
 * old name is allowed when it lies inside a match. `*` allows the whole file, path included.
 */
export function parseAllowlist(text) {
  const entries = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim() || raw.startsWith('#')) return;
    const cols = raw.split('\t');
    if (cols.length !== 4 || cols.some((c) => !c.trim())) {
      throw new Error(
        `allowlist line ${i + 1}: expected 4 tab-separated columns (class, glob, regex, reason)`,
      );
    }
    const [cls, glob, regex, reason] = cols.map((c) => c.trim());
    entries.push({
      line: i + 1,
      cls,
      glob,
      path: globToRegExp(glob),
      whole: regex === '*',
      re: regex === '*' ? null : new RegExp(regex, 'g'),
      reason,
      used: false,
    });
  });
  return entries;
}

/** globToRegExp: `**` crosses directories, `*` and `?` do not; the pattern is relative to the repo root. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** entriesFor returns the allowlist entries that apply to a repository path. */
export function entriesFor(entries, path) {
  return entries.filter((e) => e.path.test(path));
}

/** wholeFile reports whether an entry allows the whole file (and its path), marking it used. */
export function wholeFile(fileEntries) {
  const e = fileEntries.find((x) => x.whole);
  if (e) e.used = true;
  return Boolean(e);
}

// allowedSpans returns the [start, end) ranges of a line that the entries allow.
function allowedSpans(fileEntries, line) {
  const spans = [];
  for (const e of fileEntries) {
    if (e.whole) continue;
    e.re.lastIndex = 0;
    for (let m; (m = e.re.exec(line));) {
      if (m[0] === '') {
        e.re.lastIndex++;
        continue;
      }
      spans.push({ start: m.index, end: m.index + m[0].length, entry: e });
    }
  }
  return spans;
}

/**
 * occurrences returns every occurrence of the old name in a line as {index, text, allowed}, and
 * marks the entries that allowed one as used.
 */
export function occurrences(fileEntries, line) {
  const out = [];
  if (!line.match(OLD)) return out;
  const spans = allowedSpans(fileEntries, line);
  OLD.lastIndex = 0;
  for (let m; (m = OLD.exec(line));) {
    const start = m.index;
    const end = start + m[0].length;
    const span = spans.find((s) => s.start <= start && end <= s.end);
    if (span) span.entry.used = true;
    out.push({ index: start, text: m[0], allowed: Boolean(span) });
  }
  return out;
}

/** renameLine renames a line outside the ranges the entries allow. */
export function renameLine(fileEntries, line) {
  if (!line.match(OLD)) return line;
  const spans = allowedSpans(fileEntries, line).sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue; // overlapping matches: the first one wins
    out += renameText(line.slice(at, s.start)) + line.slice(s.start, s.end);
    at = s.end;
  }
  return out + renameText(line.slice(at));
}
