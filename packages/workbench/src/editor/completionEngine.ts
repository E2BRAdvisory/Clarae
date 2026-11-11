// The engine of the completions of `[[wikilinks]]` (notes, aliases, #headings, #^blocks) and #tags, which
// knows nothing of an editor: it takes the text in front of the caret and answers with the candidates and
// where the text they replace starts. CodeMirror (completions.ts) and the Live editor (live/input/suggest.ts)
// are two adapters of it. Ranking happens in the backend (fuzzy), so every keystroke asks again instead of
// filtering on the client.
import type { Suggestion, SuggestKind } from '../app/api';

export type LinkFormat = 'shortest' | 'path' | 'relative';

export interface CompletionBackend {
  suggest(kind: SuggestKind, query: string, notePath: string): Promise<Suggestion[]>;
  resolve(from: string, target: string): Promise<string>;
}

export interface CompletionOptions {
  backend: CompletionBackend;
  notePath: () => string;
  linkFormat: () => LinkFormat;
}

const stripMd = (p: string): string => p.replace(/\.md$/, '');

/** The text to put inside [[ ]] for a note, honoring the "link format" setting. */
export function linkTextFor(
  s: Suggestion,
  from: string,
  format: LinkFormat,
  ambiguous: boolean,
): string {
  const path = stripMd(s.path);
  if (format === 'path') return path;
  if (format === 'relative') {
    const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : [];
    const target = path.split('/');
    let i = 0;
    while (i < fromDir.length && i < target.length - 1 && fromDir[i] === target[i]) i++;
    return [...fromDir.slice(i).map(() => '..'), ...target.slice(i)].join('/');
  }
  if (ambiguous) return path;
  // Only a .md note resolves by its bare title; a presentation (.marp) needs its full name.
  return /\.md$/i.test(s.path) ? stripMd(s.label) : s.path.slice(s.path.lastIndexOf('/') + 1);
}

/** One thing the user can pick. `insert` is the text that goes where the typed text was. */
export interface Candidate {
  label: string;
  /** What is shown when it is not the label. */
  displayLabel?: string;
  detail?: string;
  type: 'class' | 'variable' | 'keyword' | 'text' | 'property';
  insert: string;
}

export interface CandidateSet {
  /** Offset in the text in front of the caret where the text that the candidates replace starts. */
  from: number;
  options: Candidate[];
}

/** The `[[…` that the caret is in (no `]` and no line break since the brackets). */
export const WIKILINK_BEFORE = /\[\[[^\]\n]*$/;
/** A `#tag` being typed, after the start of the text or a character that bounds a tag. */
export const TAG_BEFORE = /(?:^|[\s([{,;])#[\p{L}\p{N}_\-/]*$/u;

const candidate = (c: Omit<Candidate, 'displayLabel' | 'detail'>, extra: Partial<Candidate>) => ({
  ...c,
  ...extra,
});

/** Candidates for the `[[` the text ends in, or null when it does not end in one. */
export async function wikilinkCandidates(
  before: string,
  o: CompletionOptions,
): Promise<CandidateSet | null> {
  const m = WIKILINK_BEFORE.exec(before);
  if (!m) return null;
  const typed = m[0].slice(2);
  const from = m.index + 2;
  const here = o.notePath();

  const hash = typed.indexOf('#');
  if (hash >= 0) {
    const targetText = typed.slice(0, hash);
    const rest = typed.slice(hash + 1);
    const notePath = targetText ? await o.backend.resolve(here, targetText) : here;
    if (!notePath) return null;
    if (rest.startsWith('^')) {
      const items = await o.backend.suggest('blocks', rest.slice(1), notePath);
      return {
        from,
        options: items.map((s) =>
          candidate(
            {
              label: `${targetText}#^${s.label}`,
              type: 'text',
              insert: `${targetText}#^${s.label}`,
            },
            { displayLabel: `^${s.label}`, detail: s.detail },
          ),
        ),
      };
    }
    const items = await o.backend.suggest('headings', rest, notePath);
    return {
      from,
      options: items.map((s) =>
        candidate(
          {
            label: `${targetText}#${s.label}`,
            type: 'keyword',
            insert: `${targetText}#${s.label}`,
          },
          { displayLabel: s.label, detail: s.detail },
        ),
      ),
    };
  }

  const items = await o.backend.suggest('notes', typed, '');
  const counts = new Map<string, number>();
  for (const s of items)
    if (s.kind === 'note')
      counts.set(s.label.toLowerCase(), (counts.get(s.label.toLowerCase()) ?? 0) + 1);
  return {
    from,
    options: items.map((s) => {
      const ambiguous = (counts.get(s.label.toLowerCase()) ?? 0) > 1;
      const text = linkTextFor(s, here, o.linkFormat(), ambiguous);
      const alias = s.kind === 'alias';
      return candidate(
        {
          label: alias ? s.label : text,
          type: alias ? 'variable' : 'class',
          insert: alias ? `${text}|${s.label}` : text,
        },
        { detail: alias ? `→ ${s.detail}` : s.detail },
      );
    }),
  };
}

/**
 * Candidates for the `#tag` the text ends in. A `#` alone is a heading marker at the start of a
 * line, not a tag: it completes once a character follows, or when the user asks (`explicit`).
 */
export async function tagCandidates(
  before: string,
  explicit: boolean,
  o: CompletionOptions,
): Promise<CandidateSet | null> {
  const m = TAG_BEFORE.exec(before);
  if (!m) return null;
  const hashAt = m[0].lastIndexOf('#');
  const typed = m[0].slice(hashAt + 1);
  if (typed === '' && !explicit) return null;
  const items = await o.backend.suggest('tags', typed, '');
  return {
    from: m.index + hashAt + 1,
    options: items.map((s) =>
      candidate({ label: s.label, type: 'keyword', insert: s.label }, { detail: `${s.detail}×` }),
    ),
  };
}
