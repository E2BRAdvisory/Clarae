// Types shared by the editor engines (CodeMirror today) and by whoever talks to the editor
// through a NoteEditorHandle: they carry no engine type, so they can be imported anywhere.

/** A wikilink or embed as the user wrote it. */
export interface LinkSpec {
  target: string;
  heading: string;
  block: string;
  /** Display text, or the size for embeds ("300" / "300x200"). */
  alias: string;
  embed: boolean;
}

/** Link resolution finished: what a note editor asks to be told, to show its links again. */
export interface LinkResolver {
  subscribe(cb: () => void): () => void;
}

/** The figures of the editor: words, characters, selection, and the position of the cursor. */
export interface EditorStats {
  words: number;
  chars: number;
  selWords: number;
  /** The characters of the selection, as `selectionMarkdown()` returns it. */
  selChars: number;
  /** 1-based line of the cursor in the source. */
  line: number;
  /** 1-based column of the cursor in its source line. */
  col: number;
}

/**
 * One replacement in the source of a note, in UTF-16 offsets of the text it was computed against:
 * `to` defaults to `from` (an insertion) and `insert` to nothing (a deletion).
 */
export interface SourceEdit {
  from: number;
  to?: number;
  insert?: string;
}

/** A rectangle in viewport coordinates that a popover is anchored to. */
export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
