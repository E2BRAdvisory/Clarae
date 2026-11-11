// The Live editor behind NoteEditorHandle (A-W4): Milkdown (through Crepe) on the fidelity layer of A-W3.
//
// The note's text is the one source of truth. The document the user edits is a view of it, and the text
// comes back from the layer only when somebody asks (`text()`, lazy and memoized by document), never as
// a side effect of typing: no `markdownUpdated` listener, nothing is serialized on a keystroke.
//
//   what the user does       a transaction; if it changed the document and is no machine's housekeeping,
//                            `onChange` gets a getter of the text of that edit
//   what the file did        `reload(raw)`: the table is rebuilt from the new text and the document is
//                            replaced by a transaction that is kept out of the undo history
//   what a command does      edits made in the text (insert, append, edits against a base) re-read the
//                            changed text the same way, as one undo step
//
// Source lines and columns are what the handle speaks (positions.ts maps them): the line is exact, the
// column is approximate inside a block (ADR-0049).
import { extract, parseWikilinkInner } from '@memobrain/markdown';
import type { Ctx } from '@milkdown/kit/ctx';
import type { CrepeBuilder } from '@milkdown/crepe/builder';
import { setCodeMirrorTheme } from '@milkdown/crepe/feature/code-mirror';
import { Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { countWords } from '../stats';
import { attachmentName, attachmentUrl, toBase64 } from '../pasteCore';
import type {
  EditorCommand,
  EditResult,
  LinkHit,
  NoteEditorHandle,
  RevealTarget,
  ViewSnapshot,
} from '../handle';
import type { AnchorRect, EditorStats, SourceEdit } from '../types';
import { loadEmoji, loadLanguages } from './chunks';
import { COMMANDS } from './commands';
import { buildCrepe, EXTERNAL_META, type CrepeLabels } from './crepe';
import { installDomShims } from './domShims';
import { attachFoldHover, FindBar, foldKey, type LiveSettings } from './frame';
import { inertInput, type LiveInputApp } from './input';
import { LiveSession, type Fallback, type Refused } from './fidelity/session';
import { locsOf, locInText, offsetInText, posAt, type Loc } from './positions';
import { captureSurface, type EditorSurface } from './surface';
import { attachAi } from './ai/feature';
import { attachCollab, type CollabAttachment, type CollabSession } from './collab/attach';
import type { CollabRoom } from './collab/providers';
import { attachInteractions, LiveHost, wikilinkUnder, type LiveViewsHost } from './views';

export type { Fallback, Refused };

export interface LiveEditorOptions {
  paneId: string;
  readOnly: boolean;
  /** The editor settings in force; `applySettings` brings later changes in. */
  settings: LiveSettings;
  labels: CrepeLabels;
  ariaLabel: string;
  /** The application, for the views of links, embeds, images and the rest (a plain one without it). */
  views?: LiveViewsHost;
  /** The application's side of the input: suggestions, attachments, the settings that tune it (inert without it). */
  input?: LiveInputApp;
  /**
   * Where the note is shared, for collaboration (ADR-0050): off, so it never matters in a build without
   * the constant, the flag and a provider (there is none). Read once, when the editor is opened.
   */
  collabRoom?: () => CollabRoom | undefined;
  /**
   * The vault of the note, for the AI assistant (ADR-0050): off, so it never matters in a build without
   * the constant (`MEMOBRAIN_AI`), the `ai` flag, the capability, a vault that is not private and a core
   * that answers `Status` as available. Read once, when the editor is opened.
   */
  vaultId?: () => string | undefined;
  /** The application's hotkeys: true when the event ran a command (and was handled). Read at every key. */
  hotkey(): ((event: KeyboardEvent) => boolean) | undefined;
  /** After an edit by the user, with a getter of the text of that edit (see NoteView / useNoteDocument). */
  onChange(text: () => string): void;
  /** After the document or the selection changed (the status bar's figures). */
  onUpdate(): void;
  /** The editor took the keyboard focus. */
  onFocus(): void;
}

export type OpenedLive =
  | { ok: true; editor: LiveEditor }
  | Refused
  // `load`: the editor could not be built or its chunks fetched; `identity`: the layer does not give
  // the note back as it is (what is not touched is the file, byte for byte, or the note stays in Source)
  | { ok: false; reason: 'load' | 'identity'; detail: string };

/**
 * Opens a note in the Live editor, in `parent`. Resolves to the editor, or to the reason why the note
 * should open in Source instead (the layer cannot hold it without changing it: A-D3).
 */
export async function openLiveEditor(
  parent: HTMLElement,
  raw: string,
  opts: LiveEditorOptions,
): Promise<OpenedLive> {
  let builder: CrepeBuilder | null = null;
  try {
    installDomShims();
    const [{ languages, codeExtensions }, emoji] = await Promise.all([
      loadLanguages(),
      loadEmoji(),
    ]);
    let live: LiveEditor | null = null;
    const views = opts.views ?? new LiveHost();
    const app = opts.input ?? inertInput;
    builder = buildCrepe({
      root: parent,
      languages,
      emoji,
      labels: opts.labels,
      ariaLabel: opts.ariaLabel,
      spellcheck: opts.settings.spellcheck,
      codeTheme: codeExtensions({ ...opts.settings, label: opts.labels.codeBlock }),
      foldHeadings: opts.settings.foldHeadings,
      views,
      input: {
        ...app,
        readOnly: () => live?.readOnlyNow ?? opts.readOnly,
        exec: (command) => live?.exec(command) ?? false,
      },
      upload: async (file) => {
        try {
          const path = await app.paste.saveAttachment(attachmentName(file), await toBase64(file));
          // a path is written in a link the way a file name is: spaces and the like, encoded
          return attachmentUrl(path);
        } catch (e) {
          app.paste.onError?.(e);
          throw e;
        }
      },
      readOnly: () => live?.readOnlyNow ?? opts.readOnly,
      hooks: { update: (docChanged, userEdit) => live?.transaction(docChanged, userEdit) },
    });
    const surfaceOf = captureSurface(builder.editor);
    // The AI assistant is off: with any gate closed (every build but the one made for it) this loads nothing
    // and returns false, and the chunk is not fetched. A failure of it never keeps a note from opening.
    const vaultId = opts.vaultId?.();
    if (vaultId) await attachAi(builder, { vaultId }).catch(() => false);
    // Collaboration is off: with any gate closed (every build today) this loads nothing and returns
    // null. A failure of it never keeps a note from opening.
    const collab: CollabAttachment | null = await attachCollab(builder.editor, {
      room: opts.collabRoom?.(),
    }).catch(() => null);
    await builder.create();
    const surface = surfaceOf();
    const opened = LiveSession.open(surface, raw);
    if (!opened.ok) {
      await builder.destroy();
      return opened;
    }
    let ctx!: Ctx;
    builder.editor.action((c) => void (ctx = c));
    live = new LiveEditor(
      parent,
      builder,
      surface,
      opened.session,
      ctx,
      opts,
      views,
      codeExtensions,
    );
    // the guard of the layer's first property: a note that was not touched is the file
    if (live.text() !== raw) {
      await live.close();
      return {
        ok: false,
        reason: 'identity',
        detail: 'the loaded document does not give the note back',
      };
    }
    if (collab) {
      const editor = live;
      void collab.start(ctx, raw).then(
        (s) => editor.bindCollab(s),
        () => undefined,
      );
    }
    return { ok: true, editor: live };
  } catch (e) {
    await builder?.destroy().catch(() => undefined);
    return { ok: false, reason: 'load', detail: e instanceof Error ? e.message : String(e) };
  }
}

const rectOf = (r: DOMRect): AnchorRect => ({
  left: r.left,
  right: r.right,
  top: r.top,
  bottom: r.bottom,
});

export class LiveEditor implements NoteEditorHandle {
  readonly kind = 'live' as const;
  readonly paneId: string;
  readonly root: HTMLElement;
  /** What read-only means now (the filter of the editor reads the same flag). */
  readOnlyNow: boolean;

  /** The user has edited the note here since it was opened or loaded again. */
  edited = false;
  private texts = new WeakMap<PMNode, string>();
  private readonly findBar: FindBar;
  private settings: LiveSettings;
  private disposed = false;
  private closing: Promise<void> | null = null;
  private readonly off: (() => void)[] = [];
  private collab: CollabSession | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly builder: CrepeBuilder,
    private readonly surface: EditorSurface,
    private readonly session: LiveSession,
    private readonly ctx: Ctx,
    private readonly opts: LiveEditorOptions,
    views: LiveViewsHost,
    private readonly codeExtensions: (o: {
      dark: boolean;
      tabSize: number;
      label: string;
    }) => unknown,
  ) {
    this.paneId = opts.paneId;
    this.readOnlyNow = opts.readOnly;
    parent.dataset['readonly'] = String(opts.readOnly);
    this.root = parent;
    this.listen(
      'keydown',
      (e) => {
        const ke = e as KeyboardEvent;
        // An IME composition owns the keys until it ends. The listener is on the host and in the capture
        // phase: it sees the keys of the code blocks and the table cells (editors of their own) and the
        // tooltips, which the keymap of ProseMirror does not.
        if (ke.isComposing || ke.keyCode === 229) return;
        // The find bar is outside the document and has its own keys; the rest of the application's
        // hotkeys reach it from the window as they do from any field.
        if ((ke.target as Element | null)?.closest?.('.live-find')) return;
        if (this.opts.hotkey()?.(ke)) ke.stopPropagation();
      },
      true,
    );
    // A link in the document is never followed by the browser: opening it is the editor's business.
    this.listen(
      'click',
      (e) => {
        if ((e.target as Element | null)?.closest?.('a[href]')) e.preventDefault();
      },
      true,
    );
    this.listen('focusin', () => this.opts.onFocus());
    // Mod+click on a link, the page preview on hover
    this.off.push(attachInteractions(parent, views, () => this.view));
    // The chevron of an open block, for the pointer (the folded ones draw their own)
    this.off.push(attachFoldHover(parent, () => this.view));
    this.findBar = new FindBar({
      parent,
      view: () => this.view,
      readOnly: () => this.readOnlyNow,
    });
    this.off.push(() => this.findBar.dispose());
    this.settings = { ...opts.settings };
    this.applyLook(this.settings);
  }

  private listen(type: string, fn: (e: Event) => void, capture = false): void {
    this.parent.addEventListener(type, fn, capture);
    this.off.push(() => this.parent.removeEventListener(type, fn, capture));
  }

  private get view(): EditorView {
    return this.surface.view;
  }

  // ---- the view's side ---------------------------------------------------------------------------

  /** A transaction went through the view (crepe.ts). */
  transaction(_docChanged: boolean, userEdit: boolean): void {
    if (this.disposed) return;
    if (userEdit) this.changed();
    this.findBar.refresh();
    this.opts.onUpdate();
  }

  private changed(): void {
    this.edited = true;
    this.opts.onChange(this.lazyText());
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnlyNow = readOnly;
    // the controls the editor draws (table handles, the language of a code block) go with it
    this.parent.dataset['readonly'] = String(readOnly);
    this.findBar.refresh();
  }

  /**
   * Follows the settings of the application while the editor is open: the spellchecker, the size of the
   * type, wrapping, folding, and the tab width and the colours of the code blocks (which follow the theme).
   */
  applySettings(next: LiveSettings): void {
    const prev = this.settings;
    this.settings = { ...next };
    this.applyLook(next);
    if (next.spellcheck !== prev.spellcheck) {
      const { view } = this;
      const attributes = typeof view.props.attributes === 'object' ? view.props.attributes : {};
      view.setProps({ attributes: { ...attributes, spellcheck: String(next.spellcheck) } });
    }
    if (next.foldHeadings !== prev.foldHeadings) {
      this.view.dispatch(this.view.state.tr.setMeta(foldKey, { enabled: next.foldHeadings }));
    }
    if (next.tabSize !== prev.tabSize || next.dark !== prev.dark) {
      this.builder.editor.action(
        setCodeMirrorTheme(
          this.codeExtensions({
            dark: next.dark,
            tabSize: next.tabSize,
            label: this.opts.labels.codeBlock,
          }) as Parameters<typeof setCodeMirrorTheme>[0],
        ),
      );
    }
  }

  /** What the settings change in the look of the editor: the type size, wrapping, the tab width. */
  private applyLook(s: LiveSettings): void {
    this.parent.style.setProperty('--live-font-size', `${s.fontSize}px`);
    this.parent.style.setProperty('--live-tab-size', String(s.tabSize));
    this.parent.dataset['wrap'] = String(s.wrap);
  }

  /** Hands over the started collaboration, which this editor then stops with itself. */
  bindCollab(session: CollabSession): void {
    if (this.disposed) void session.stop().catch(() => undefined);
    else this.collab = session;
  }

  /** Stops listening and tears the editor down; the text of the current document stays available. */
  dispose(): void {
    void this.close();
  }

  /** `dispose`, resolved when the editor is gone. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    try {
      this.text(); // a getter given out earlier may still be asked after this: its text is kept
    } catch {
      /* the editor was already broken: nothing to keep */
    }
    this.disposed = true;
    for (const off of this.off.splice(0)) off();
    void this.collab?.stop().catch(() => undefined);
    this.collab = null;
    this.closing = this.builder.destroy().then(
      () => undefined,
      () => undefined,
    );
    return this.closing;
  }

  // ---- the text ----------------------------------------------------------------------------------

  private textOf(doc: PMNode): string {
    let t = this.texts.get(doc);
    if (t === undefined) {
      t = this.session.text(doc);
      this.texts.set(doc, t);
    }
    return t;
  }

  /** A getter of the text of the document as it is now: it keeps giving that text, whatever comes after. */
  private lazyText(): () => string {
    const doc = this.view.state.doc;
    return () => this.textOf(doc);
  }

  private get textSource() {
    return { text: (doc: PMNode) => this.textOf(doc) };
  }

  /** The line ending of the file, for text that is put into it. */
  private eol(text: string): string {
    return text.replace(/\r\n?|\n/g, this.session.envelope.eol);
  }

  text(): string {
    return this.textOf(this.view.state.doc);
  }

  /**
   * Puts a whole new text in the place of the note's: the table is rebuilt from it, and the document
   * is replaced over the span that differs. An edit of the user is one undo step; what the file did
   * stays out of the history.
   */
  private applyText(
    raw: string,
    o: { user: boolean; caret?: number },
  ): 'noop' | 'changed' | Refused {
    const { view } = this;
    if (raw === this.text()) return 'noop';
    const before = view.state;
    const r = this.session.reload(raw);
    if ('ok' in r) {
      view.updateState(before); // the load may have left the view on the document it refused
      return r;
    }
    this.texts = new WeakMap();
    if (r.doc === null) {
      // only the envelope changed: the document is what it was, the text is not
      if (o.user) this.changed();
      this.opts.onUpdate();
      return 'changed';
    }
    const loaded = view.state;
    view.updateState(before);
    const a = before.doc;
    const b = loaded.doc;
    const start = a.content.findDiffStart(b.content);
    if (start !== null) {
      const end = a.content.findDiffEnd(b.content);
      let endA = end ? end.a : a.content.size;
      let endB = end ? end.b : b.content.size;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      const tr = before.tr.replace(start, endA, b.slice(start, endB));
      if (o.user) tr.setMeta('addToHistory', true);
      else tr.setMeta('addToHistory', false).setMeta(EXTERNAL_META, true);
      view.dispatch(tr);
      // the replaced span is not always the document's own shape (a slice that does not fit the
      // schema is fitted): the document of the new text is what must show, the history is not worth it
      if (!view.state.doc.eq(b)) view.updateState(loaded);
    } else if (o.user) {
      this.changed();
    }
    if (o.caret !== undefined) this.placeCaret(locInText(raw, o.caret));
    this.opts.onUpdate();
    return 'changed';
  }

  private placeCaret(loc: Loc): void {
    const { view } = this;
    const pos = posAt(this.textSource, view.state.doc, loc);
    view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))));
  }

  /** What the document does after the file changed outside (null when it was taken); a refusal means "open it in Source". */
  reload(raw: string): Refused | null {
    const r = this.applyText(raw, { user: false });
    // Taken or refused, what this editor holds is no longer the note's text: the file is, and a refusal
    // means the other editor shows it. What was typed here must not go over it on the way out.
    this.edited = false;
    return typeof r !== 'string' ? r : null;
  }

  // ---- reading -----------------------------------------------------------------------------------

  get focusElement(): HTMLElement {
    return this.view.dom;
  }
  focus(): void {
    this.view.focus();
  }
  readOnly(): boolean {
    return this.readOnlyNow;
  }

  cursor(): { line: number; col: number } {
    const { doc, selection } = this.view.state;
    return locsOf(this.textSource, doc, [{ pos: selection.head }])[0] as Loc;
  }

  /** The offsets in `text()` of the selection's two ends. */
  private selectionOffsets(): { from: number; to: number } {
    const { doc, selection } = this.view.state;
    const text = this.text();
    // the selected text starts inside what follows the start and ends inside what precedes the end
    const [a, b] = locsOf(this.textSource, doc, [
      { pos: selection.from, bias: 1 },
      { pos: selection.to, bias: -1 },
    ]) as [Loc, Loc];
    return { from: offsetInText(text, a), to: offsetInText(text, b) };
  }

  selectionMarkdown(): string {
    const { selection } = this.view.state;
    if (selection.empty) return '';
    const { from, to } = this.selectionOffsets();
    return this.text().slice(from, to);
  }

  stats(): EditorStats {
    const text = this.text();
    const { selection, doc } = this.view.state;
    const all = selection.from <= 1 && selection.to >= doc.content.size - 1 && !selection.empty;
    const words = countWords(text);
    const picked = all ? text : this.selectionMarkdown();
    const { line, col } = this.cursor();
    return {
      words,
      chars: text.length,
      selWords: all ? words : countWords(picked),
      selChars: picked.length,
      line,
      col,
    };
  }

  // ---- editing -----------------------------------------------------------------------------------

  replaceSelection(markdown: string, opts: { caret?: number } = {}): boolean {
    if (this.readOnlyNow) return false;
    const text = this.text();
    const { from, to } = this.selectionOffsets();
    const insert = this.eol(markdown);
    const next = text.slice(0, from) + insert + text.slice(to);
    const caret = from + (opts.caret ?? insert.length);
    return typeof this.applyText(next, { user: true, caret }) === 'string';
  }

  replaceSelectionIf(expected: string, markdown: string): boolean {
    if (this.selectionMarkdown() !== expected) return false;
    return this.replaceSelection(markdown);
  }

  appendToLine(line: number, insert: string): boolean {
    if (this.readOnlyNow) return false;
    const text = this.text();
    const lines = text.split('\n').length;
    if (!Number.isInteger(line) || line < 1 || line > lines) return false;
    const end = offsetInText(text, { line, col: Number.MAX_SAFE_INTEGER });
    const next = text.slice(0, end) + this.eol(insert) + text.slice(end);
    return typeof this.applyText(next, { user: true }) === 'string';
  }

  applySourceEdits(base: string, edits: readonly SourceEdit[], _userEvent?: string): EditResult {
    if (this.text() !== base) return false;
    if (edits.length === 0) return 'noop';
    if (this.readOnlyNow) return false;
    let next = '';
    let at = 0;
    for (const e of [...edits].sort((x, y) => x.from - y.from)) {
      next += base.slice(at, e.from) + this.eol(e.insert ?? '');
      at = e.to ?? e.from;
    }
    next += base.slice(at);
    if (next === base) return 'noop';
    const r = this.applyText(next, { user: true });
    return typeof r === 'string' ? (r === 'noop' ? 'noop' : 'changed') : false;
  }

  exec(command: EditorCommand): boolean {
    if (this.readOnlyNow) return false;
    return COMMANDS[command]({ view: this.view, schema: this.surface.schema, ctx: () => this.ctx });
  }

  // ---- moving ------------------------------------------------------------------------------------

  reveal(target: RevealTarget): void {
    let line = target.line ?? 0;
    if (!line) {
      const note = extract('', this.text());
      if (target.block) line = note.blockIds.find((b) => b.id === target.block)?.line ?? 0;
      else if (target.heading) {
        const norm = (s: string) =>
          s
            .toLowerCase()
            .replace(/[*_`=~[\]]/g, '')
            .trim();
        line = note.headings.find((h) => norm(h.text) === norm(target.heading ?? ''))?.line ?? 0;
      }
    }
    if (line < 1 || line > this.text().split('\n').length) return;
    this.moveTo({ line, col: 1 }, undefined, 'start');
    this.focus();
  }

  gotoLine(line: number): void {
    const lines = this.text().split('\n').length;
    this.moveTo({ line: Math.min(lines, Math.max(1, Math.trunc(line) || 1)), col: 1 });
    this.focus();
  }

  private moveTo(anchor: Loc, head?: Loc, scroll: 'start' | 'nearest' = 'nearest'): void {
    const { view } = this;
    const doc = view.state.doc;
    const a = posAt(this.textSource, doc, anchor);
    const h = head ? posAt(this.textSource, doc, head) : a;
    const sel = TextSelection.between(doc.resolve(a), doc.resolve(h));
    view.dispatch(view.state.tr.setSelection(sel));
    if (scroll === 'start') this.scrollToTop(sel.head);
    else view.dispatch(view.state.tr.scrollIntoView());
  }

  /** Scrolls so that a position is near the top of the editor (the way a revealed heading is shown). */
  private scrollToTop(pos: number): void {
    try {
      const c = this.view.coordsAtPos(pos);
      this.root.scrollTop += c.top - this.root.getBoundingClientRect().top - 24;
    } catch {
      this.view.dispatch(this.view.state.tr.scrollIntoView()); // no layout (a test): at least show it
    }
  }

  linkAt(at: { x: number; y: number } | 'cursor'): LinkHit | null {
    const { view } = this;
    if (at !== 'cursor') {
      // what is under the pointer: the link itself, not the end of its line
      const { root } = view;
      if (typeof root.elementFromPoint === 'function') {
        const el = root.elementFromPoint(at.x, at.y);
        const hit = el ? wikilinkUnder(el) : null;
        return hit ? { spec: hit.spec, rect: rectOf(hit.rect) } : null;
      }
      let pos: number | null = null;
      try {
        pos = view.posAtCoords({ left: at.x, top: at.y })?.pos ?? null;
      } catch {
        /* no layout */
      }
      return pos === null ? null : this.linkIn(pos, false);
    }
    return this.linkIn(view.state.selection.head, true);
  }

  /** The wikilink the position is in (or, for the caret, next to: its source shows there), if any. */
  private linkIn(pos: number, adjacent: boolean): LinkHit | null {
    const { view } = this;
    const $pos = view.state.doc.resolve(pos);
    let found: { node: PMNode; at: number } | null = null;
    for (let d = $pos.depth; d > 0 && !found; d--) {
      const n = $pos.node(d);
      if (n.type.name === 'ofm_wikilink') found = { node: n, at: $pos.before(d) };
    }
    if (!found && adjacent) {
      const { nodeBefore, nodeAfter } = $pos;
      if (nodeAfter?.type.name === 'ofm_wikilink') found = { node: nodeAfter, at: pos };
      else if (nodeBefore?.type.name === 'ofm_wikilink') {
        found = { node: nodeBefore, at: pos - nodeBefore.nodeSize };
      }
    }
    if (!found || found.node.attrs['embed']) return null;
    const p = parseWikilinkInner(found.node.textContent);
    if (!p.target && !p.heading && !p.block) return null;
    const dom = view.nodeDOM(found.at);
    if (!(dom instanceof HTMLElement)) return null;
    return {
      spec: { target: p.target, heading: p.heading, block: p.block, alias: p.alias, embed: false },
      rect: rectOf(dom.getBoundingClientRect()),
    };
  }

  openSearch(): void {
    // the selected text, when it is one line of it, is what to look for
    const { selection, doc } = this.view.state;
    const picked = selection.empty ? '' : doc.textBetween(selection.from, selection.to, ' ', ' ');
    this.findBar.open(picked && !/\n/.test(picked) && picked.length <= 200 ? picked : undefined);
  }

  snapshot(): ViewSnapshot {
    const { view } = this;
    const { doc, selection } = view.state;
    const [a, h] = locsOf(this.textSource, doc, [
      { pos: selection.anchor },
      { pos: selection.head },
    ]) as [Loc, Loc];
    let topLine = h.line;
    try {
      const rect = this.root.getBoundingClientRect();
      const top = view.posAtCoords({ left: rect.left + rect.width / 2, top: rect.top + 4 });
      if (top) topLine = locsOf(this.textSource, doc, [{ pos: top.pos }])[0]!.line;
    } catch {
      /* no layout: the cursor's line stands for it */
    }
    return { anchor: a, head: h, topLine };
  }

  restore(snapshot: ViewSnapshot): void {
    const lines = this.text().split('\n').length;
    const clamp = (p: Loc): Loc => ({
      line: Math.min(lines, Math.max(1, p.line)),
      col: Math.max(1, p.col),
    });
    this.moveTo(clamp(snapshot.anchor), clamp(snapshot.head));
    try {
      const { view } = this;
      const top = posAt(this.textSource, view.state.doc, {
        line: Math.min(lines, Math.max(1, snapshot.topLine)),
        col: 1,
      });
      const rect = this.root.getBoundingClientRect();
      if (snapshot.topLine <= 1) this.root.scrollTop = 0;
      else this.root.scrollTop += view.coordsAtPos(top).top - rect.top;
    } catch {
      /* no layout: the selection is back, and shown */
    }
  }
}
