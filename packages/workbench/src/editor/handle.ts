// What the rest of the application sees of a note editor (ADR-0049): a semantic handle, never the
// engine's view. Everything is expressed in the source text of the note (1-based lines, UTF-16
// offsets of the whole text), so that an engine that does not edit the source directly can honour
// it too: no method takes an offset inside a block, and none gives back the view.
import type { AnchorRect, EditorStats, LinkSpec, SourceEdit } from './types';

/**
 * Formatting and insertion commands every engine implements (`exec`). `move-up` and `move-down` move
 * what the selection is in: the selected lines in Source, the list items or blocks in Live.
 */
export type EditorCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'underline'
  | 'highlight'
  | 'code'
  | 'comment'
  | 'sub'
  | 'sup'
  | 'link'
  | 'wikilink'
  | 'embed'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'bullet'
  | 'numbered'
  | 'quote'
  | 'task'
  | 'callout'
  | 'code-block'
  | 'table'
  | 'math'
  | 'separator'
  | 'clear'
  | 'move-up'
  | 'move-down'
  | 'undo'
  | 'redo';

/** The heading commands, by level. */
export const HEADING_COMMANDS = [
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
] as const satisfies readonly EditorCommand[];

/** `heading-n` for a level of 1 to 6. */
export const headingCommand = (level: number): EditorCommand =>
  HEADING_COMMANDS[Math.min(6, Math.max(1, level)) - 1] ?? 'heading-1';

/** What `reveal` brings into view: a source line (1-based), a heading by its text, or a block `^id`. */
export interface RevealTarget {
  line?: number;
  heading?: string;
  block?: string;
}

/** Where the cursor and the view were, in source lines (1-based), to put them back later. */
export interface ViewSnapshot {
  anchor: { line: number; col: number };
  head: { line: number; col: number };
  /** First line of the source that is visible at the top of the view. */
  topLine: number;
}

export interface LinkHit {
  spec: LinkSpec;
  /** Where the link is on screen. */
  rect: AnchorRect;
}

/** `false`: not applied; `'noop'`: applied, the text stays what it was; `'changed'`: the text changed. */
export type EditResult = false | 'noop' | 'changed';

export interface NoteEditorHandle {
  /** What the pane is showing now: the plain source (Source), or the Live editor. */
  readonly kind: 'source' | 'live';
  /** The pane the editor is registered under. */
  readonly paneId: string;
  /** The editor's outer element (the pane's note is found from it). */
  readonly root: HTMLElement;
  /** The element that holds the keyboard focus while the user types: where focus returns to. */
  readonly focusElement: HTMLElement;

  focus(): void;
  /** Whether the editor refuses edits (a vault that is read-only, a viewer on a share). */
  readOnly(): boolean;

  /** The whole source text. */
  text(): string;
  /** Where the cursor is: line and column are 1-based, in the source. */
  cursor(): { line: number; col: number };
  /** The selected text as Markdown source, '' when nothing is selected. */
  selectionMarkdown(): string;

  /**
   * Replaces the selection with Markdown; the caret goes `caret` characters into it (default: at
   * the end). One undo step.
   */
  replaceSelection(markdown: string, opts?: { caret?: number }): boolean;
  /** Same, but only while the selection still is `expected`; false (and nothing done) otherwise. */
  replaceSelectionIf(expected: string, markdown: string): boolean;
  /** Appends `text` at the end of a source line (1-based), e.g. a ` ^id` to a block. */
  appendToLine(line: number, text: string): boolean;
  /**
   * Applies edits computed against `base`, as one undo step. false when the text is no longer
   * `base`; 'noop' when the edits leave the text as it was (nothing is recorded).
   */
  applySourceEdits(base: string, edits: readonly SourceEdit[], userEvent?: string): EditResult;

  /** Runs a formatting command on the selection; true when it acted. */
  exec(command: EditorCommand): boolean;

  /** Puts the cursor at a heading, block or line and scrolls to it. */
  reveal(target: RevealTarget): void;
  /** Puts the cursor at the start of a source line (1-based; clamped to the text) and shows it. */
  gotoLine(line: number): void;
  /** The wikilink under a point of the screen or under the cursor, if any. */
  linkAt(at: { x: number; y: number } | 'cursor'): LinkHit | null;

  stats(): EditorStats;
  /** Opens the editor's find (and replace) bar. */
  openSearch(): void;
  snapshot(): ViewSnapshot;
  restore(snapshot: ViewSnapshot): void;
}
