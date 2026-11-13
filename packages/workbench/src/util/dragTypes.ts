// The drag-and-drop data types the workbench puts on `dataTransfer` for its own drags: one place, so
// the side that starts a drag and the side that accepts it cannot drift apart. They only live as long
// as the drag; nothing stores them.

/** A file or folder dragged from the file explorer (the vault path): onto a folder, or into a drawing. */
export const DRAG_PATH = 'application/x-clarae-path';
/** A tab dragged within the tab bar (the tab id). */
export const DRAG_TAB = 'application/x-clarae-tab';
/** A bookmark dragged within the bookmarks panel (its key). */
export const DRAG_BOOKMARK = 'application/x-clarae-bookmark';
