// Which transactions are an edit by the user. Apart from crepe.ts so that the plugins that need to
// tell (the suggestions, which open when the user types and not when a file is loaded again) can
// import it without importing the assembly that installs them.

/**
 * The transactions that are not an edit by the user: a machine's housekeeping (the heading ids, the
 * numbers of an ordered list) says so with `addToHistory: false`, and so does the reload of the file
 * that arrived from outside. Neither dirties the note, neither may be undone, and neither is turned
 * away by a read-only editor.
 */
export const EXTERNAL_META = 'clarae-external';

export const isUserEdit = (tr: { docChanged: boolean; getMeta(key: string): unknown }): boolean =>
  tr.docChanged && tr.getMeta('addToHistory') !== false && !tr.getMeta(EXTERNAL_META);
