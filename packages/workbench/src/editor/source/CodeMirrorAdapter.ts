// NoteEditorHandle over a CodeMirror view (the Source editor): each method
// delegates to the code the editor already had (commands.ts, stats.ts, the search panel), it adds no
// behaviour of its own. The handle is what the registry stores and what the rest of the application
// calls; the view itself does not leave this folder.
import { moveLineDown, moveLineUp, redo, undo } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { extract } from '@memobrain/markdown';
import * as fmt from './commands';
import { statsOf } from './stats';
import type {
  EditorCommand,
  EditResult,
  LinkHit,
  NoteEditorHandle,
  RevealTarget,
  ViewSnapshot,
} from '../handle';
import type { EditorStats, SourceEdit } from '../types';
import { wikilinkAtPos } from './links';

/** The CodeMirror implementation of every `EditorCommand`. */
const COMMANDS: Record<EditorCommand, (view: EditorView) => boolean> = {
  bold: fmt.toggleBold,
  italic: fmt.toggleItalic,
  strike: fmt.toggleStrike,
  underline: fmt.toggleUnderline,
  highlight: fmt.toggleHighlight,
  code: fmt.toggleInlineCode,
  comment: fmt.toggleComment,
  sub: fmt.toggleSubscript,
  sup: fmt.toggleSuperscript,
  link: fmt.insertLink,
  wikilink: fmt.insertWikilink,
  embed: fmt.insertSnippet('![[|]]'),
  'heading-1': fmt.setHeading(1),
  'heading-2': fmt.setHeading(2),
  'heading-3': fmt.setHeading(3),
  'heading-4': fmt.setHeading(4),
  'heading-5': fmt.setHeading(5),
  'heading-6': fmt.setHeading(6),
  bullet: fmt.toggleBulletList,
  numbered: fmt.toggleNumberedList,
  quote: fmt.toggleQuote,
  task: fmt.toggleTask,
  callout: fmt.insertSnippet('> [!note] |\n> '),
  'code-block': fmt.insertSnippet('```\n|\n```'),
  table: fmt.insertSnippet('| Column 1 | Column 2 |\n| --- | --- |\n| | |', ''),
  math: fmt.insertSnippet('$$\n|\n$$'),
  separator: fmt.insertSeparator,
  clear: fmt.clearFormatting,
  'move-up': moveLineUp,
  'move-down': moveLineDown,
  undo,
  redo,
};

/** How the heading text of a reveal target is compared with the headings of the note. */
const normHeading = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[*_`=~[\]]/g, '')
    .trim();

export interface CodeMirrorHandleOptions {
  paneId?: string;
}

class CodeMirrorHandle implements NoteEditorHandle {
  constructor(
    private readonly view: EditorView,
    readonly paneId: string,
  ) {}

  get kind(): 'source' {
    return 'source';
  }
  get root(): HTMLElement {
    return this.view.dom;
  }
  get focusElement(): HTMLElement {
    return this.view.contentDOM;
  }

  focus(): void {
    this.view.focus();
  }
  readOnly(): boolean {
    return this.view.state.readOnly;
  }

  text(): string {
    return this.view.state.doc.toString();
  }
  cursor(): { line: number; col: number } {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1 };
  }
  selectionMarkdown(): string {
    const sel = this.view.state.selection.main;
    return this.view.state.sliceDoc(sel.from, sel.to);
  }

  replaceSelection(markdown: string, opts: { caret?: number } = {}): boolean {
    // Without a caret every range is replaced (multi-cursor); a caret offset only makes sense
    // for the main range, which is the only one that is replaced then.
    if (opts.caret === undefined) {
      this.view.dispatch(this.view.state.replaceSelection(markdown));
      return true;
    }
    const sel = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: markdown },
      selection: { anchor: sel.from + opts.caret },
    });
    return true;
  }
  replaceSelectionIf(expected: string, markdown: string): boolean {
    if (this.selectionMarkdown() !== expected) return false;
    return this.replaceSelection(markdown);
  }
  appendToLine(line: number, text: string): boolean {
    const doc = this.view.state.doc;
    if (!Number.isInteger(line) || line < 1 || line > doc.lines) return false;
    this.view.dispatch({ changes: { from: doc.line(line).to, insert: text } });
    return true;
  }
  applySourceEdits(base: string, edits: readonly SourceEdit[], userEvent = 'input'): EditResult {
    const state = this.view.state;
    if (state.doc.toString() !== base) return false;
    if (edits.length === 0) return 'noop';
    const tr = state.update({ changes: [...edits], userEvent });
    if (tr.newDoc.eq(state.doc)) return 'noop';
    this.view.dispatch(tr);
    return 'changed';
  }

  exec(command: EditorCommand): boolean {
    return COMMANDS[command](this.view);
  }

  reveal(target: RevealTarget): void {
    const { view } = this;
    let line = target.line ?? 0;
    if (!line) {
      const note = extract('', view.state.doc.toString());
      if (target.block) line = note.blockIds.find((b) => b.id === target.block)?.line ?? 0;
      else if (target.heading)
        line =
          note.headings.find((h) => normHeading(h.text) === normHeading(target.heading ?? ''))
            ?.line ?? 0;
    }
    if (line < 1 || line > view.state.doc.lines) return;
    const pos = view.state.doc.line(line).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }),
    });
    view.focus();
  }
  gotoLine(line: number): void {
    const doc = this.view.state.doc;
    const at = doc.line(Math.min(doc.lines, Math.max(1, Math.trunc(line) || 1))).from;
    this.view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    this.view.focus();
  }
  linkAt(at: { x: number; y: number } | 'cursor'): LinkHit | null {
    const pos = at === 'cursor' ? this.view.state.selection.main.head : this.view.posAtCoords(at);
    if (pos === null) return null;
    const hit = wikilinkAtPos(this.view, pos);
    return hit?.rect ? { spec: hit.spec, rect: hit.rect } : null;
  }

  stats(): EditorStats {
    return statsOf(this.view.state);
  }
  openSearch(): void {
    openSearchPanel(this.view);
  }
  snapshot(): ViewSnapshot {
    const { view } = this;
    const doc = view.state.doc;
    const sel = view.state.selection.main;
    const at = (pos: number): { line: number; col: number } => {
      const l = doc.lineAt(pos);
      return { line: l.number, col: pos - l.from + 1 };
    };
    return {
      anchor: at(sel.anchor),
      head: at(sel.head),
      // Heights are measured from the top of the document, which is below the padding of the content.
      topLine: doc.lineAt(
        view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top))
          .from,
      ).number,
    };
  }
  restore(snapshot: ViewSnapshot): void {
    const { view } = this;
    const doc = view.state.doc;
    const pos = (p: { line: number; col: number }): number => {
      const l = doc.line(Math.min(doc.lines, Math.max(1, p.line)));
      return Math.min(l.to, l.from + Math.max(1, p.col) - 1);
    };
    const top = doc.line(Math.min(doc.lines, Math.max(1, snapshot.topLine))).from;
    view.dispatch({
      selection: { anchor: pos(snapshot.anchor), head: pos(snapshot.head) },
      effects: EditorView.scrollIntoView(top, { y: 'start' }),
    });
  }
}

const handles = new WeakMap<EditorView, NoteEditorHandle>();

/** The handle of a view: the same object every time, the first call fixes its pane. */
export function codeMirrorHandle(
  view: EditorView,
  opts: CodeMirrorHandleOptions = {},
): NoteEditorHandle {
  let h = handles.get(view);
  if (!h) {
    h = new CodeMirrorHandle(view, opts.paneId ?? '');
    handles.set(view, h);
  }
  return h;
}
