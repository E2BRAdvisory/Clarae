// A note opened in the Live editor (A-D3): the envelope and the block table of one file, and the way
// back to the text. This module knows nothing of the view: it takes the loaded document it is given.
//
//   open(raw)            raw text -> envelope + body -> loaded document -> table (or the reason why not)
//   text(doc)            document -> file text: envelope + composed body, line ends of the file
//   reload(raw)          the file changed outside: the table is rebuilt from the new text for ALL the
//                        blocks (a change of form only, `-` to `*` or CRLF, is no different from the
//                        others); a change of the frontmatter alone only replaces the envelope
//
// "Nothing is written without input" is a property of the caller (it must only ask for `text` after a
// transaction that changed the document), and of `text` itself: a document equal to the loaded one is
// the file, byte for byte.
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import {
  adoptFrontmatter,
  joinEnvelope,
  sameBody,
  splitEnvelope,
  splitInserted,
  type Envelope,
} from './envelope';
import {
  makeComposer,
  READING_LINES,
  type ComposeOptions,
  type Composer,
  type SerializerFor,
} from './compose';
import { buildTable, type BlockTable } from './table';
import type { Root } from 'mdast';

/** What the layer needs of the editor: parse, load, mdast. `LiveCore` is one. */
export interface LiveSurface extends SerializerFor {
  mdast(md: string, forceRaw?: ReadonlySet<number>): Root;
  parse(md: string, forceRaw?: ReadonlySet<number>): PMNode;
  load(md: string, forceRaw?: ReadonlySet<number>): PMNode;
}

/** Why a note does not open in Live: it opens in Source, with a notice. */
export type Fallback =
  | 'mixed-eol' // CRLF and LF in the same file: the layer would normalize it
  | 'parse-error' // Milkdown logged an error while building the document (it drops content silently)
  | 'no-table'; // the document does not line up with the Markdown tree

export interface Opened {
  ok: true;
  session: LiveSession;
}
export interface Refused {
  ok: false;
  reason: Fallback;
  detail?: string;
}

/** Runs `fn` and returns the errors Milkdown logged meanwhile: it catches and logs what it cannot parse. */
export function captureErrors<T>(fn: () => T): { value: T; errors: string[] } {
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  try {
    return { value: fn(), errors };
  } finally {
    console.error = original;
  }
}

export class LiveSession {
  private constructor(
    private readonly surface: LiveSurface,
    private readonly composer: Composer,
    public envelope: Envelope,
    public table: BlockTable,
  ) {}

  static open(surface: LiveSurface, raw: string, composer?: Composer): Opened | Refused {
    const c = composer ?? makeComposer(surface);
    const built = LiveSession.build(surface, c, splitEnvelope(raw));
    if (!built.ok) return built;
    return { ok: true, session: new LiveSession(surface, c, built.env, built.table) };
  }

  private static build(
    surface: LiveSurface,
    composer: Composer,
    env: Envelope,
  ): { ok: true; env: Envelope; table: BlockTable } | Refused {
    if (env.mixedEol) return { ok: false, reason: 'mixed-eol' };
    let raw: ReadonlySet<number> = new Set();
    // a block that is not the same note once written again is kept raw: parse again with it so
    for (let attempt = 0; attempt < 3; attempt++) {
      const { value: doc, errors } = captureErrors(() => surface.load(env.body, raw));
      if (errors.length > 0) return { ok: false, reason: 'parse-error', detail: errors[0] ?? '' };
      const table = buildTable(env.body, doc, surface.mdast(env.body, raw));
      if (!table) return { ok: false, reason: 'no-table' };
      const unstable = composer.unstableBlocks(table);
      if (unstable.size === 0) return { ok: true, env, table };
      raw = new Set([...raw, ...unstable]);
    }
    return { ok: false, reason: 'no-table', detail: 'unstable blocks' };
  }

  /** The loaded document: what the view starts from. */
  get doc(): PMNode {
    return this.table.doc;
  }

  /** The file text of `doc` (an edit of the loaded document). */
  text(doc: PMNode, opts?: ComposeOptions): string {
    return joinEnvelope(this.envelope, this.bodyOf(doc, opts));
  }

  /**
   * The body of `text`. A note whose body was empty (or blank) and now has blocks starts them on a
   * line of their own after the frontmatter: a closing line with no line end (`---` at the end of
   * the file) would take the first line in, and `...` as a closer is one to the index and to this
   * layer but not to a Markdown reader, which would read the new block as a line of its last paragraph.
   */
  private bodyOf(doc: PMNode, opts?: ComposeOptions): string {
    const body = this.guardBom(this.composer.compose(this.table, doc, opts));
    const fm = this.envelope.frontmatter;
    if (fm === '' || body === '' || !/^\s*$/.test(this.table.body)) return body;
    const bare = !fm.endsWith('\n') || /\n\.\.\.[ \t]*\n$/.test(fm);
    return bare && !body.startsWith('\n') ? '\n' + body : body;
  }

  /**
   * A byte order mark glued to the first line of the body hides it from the readers that look for a
   * fence at the start of a line (Reading closes and opens fences by line, and does not see past
   * the mark): a first line that the edit made a fence line gets a blank line before it, and so does
   * a fence line the file had when Reading prepares something else in the note (a `%%` comment is
   * blanked, or not, according to the fence state). A first line the file already had is otherwise
   * left alone. And a U+FEFF typed as the first character of the body is text, not a mark: at the
   * very start of the file it would be read as the mark and dropped.
   */
  private guardBom(body: string): string {
    if (body === this.table.body) return body;
    if (body.startsWith('\uFEFF')) return '\n' + body;
    if (this.envelope.bom === '' || this.envelope.frontmatter !== '') return body;
    const firstLine = (text: string): string => text.split('\n', 1)[0] ?? '';
    const line = firstLine(body);
    if (!/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return body;
    if (line === firstLine(this.table.body) && !READING_LINES.test(body)) return body;
    return '\n' + body;
  }

  /**
   * A fragment of Markdown (a template, a paste) is about to be inserted at the very START of the
   * note. A frontmatter at its head belongs to the envelope, not to the editor: if the note has none
   * it becomes the note's; the rest, with LF line ends, is what the editor inserts. A note that has a
   * frontmatter already keeps it, and the fragment goes in whole (the user pasted that text).
   * Anywhere but the start a frontmatter is plain text: the caller does not use this.
   */
  adoptInserted(md: string): string {
    const parts = splitInserted(md);
    if (parts.frontmatter === '') return parts.body;
    if (this.envelope.frontmatter !== '') return md.replaceAll('\r\n', '\n');
    this.envelope = adoptFrontmatter(this.envelope, parts);
    return parts.body;
  }

  /**
   * The file was changed outside. Returns the new document to show, or null when only the envelope
   * (the frontmatter, the BOM, the line ends) changed: nothing to show again, the envelope is replaced.
   * A refusal leaves the session as it was.
   */
  reload(raw: string): { doc: PMNode | null } | Refused {
    const env = splitEnvelope(raw);
    if (env.mixedEol) return { ok: false, reason: 'mixed-eol' };
    if (sameBody(env, this.envelope)) {
      this.envelope = env;
      return { doc: null };
    }
    const built = LiveSession.build(this.surface, this.composer, env);
    if (!built.ok) return built;
    this.envelope = built.env;
    this.table = built.table;
    return { doc: built.table.doc };
  }
}
