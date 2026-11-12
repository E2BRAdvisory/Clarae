// A Live editor mounted on an element of the test's document, the way the application mounts it, and
// what the tests of the adapter and of the editor share.
import type { EditorView } from '@milkdown/kit/prose/view';
import { openLiveEditor, type LiveEditor, type LiveEditorOptions } from '../MilkdownAdapter';
import type { CrepeLabels } from '../crepe';
import { DEFAULT_LIVE_SETTINGS } from '../frame';

export const labels: CrepeLabels = {
  copy: 'Copy',
  searchLanguage: 'Search language',
  noResult: 'No result',
  previewEdit: 'Edit',
  previewHide: 'Hide',
  uploadFile: 'Upload file',
  pasteLink: 'or paste link',
  confirm: 'Confirm',
  captionPlaceholder: 'Write image caption',
  task: 'Task',
  codeBlock: 'Code block',
  chrome: {
    addBlock: 'Add a block below',
    dragBlock: 'Drag to move the block',
    placeholder: 'Write, or press / for commands',
    placeholderNoSlash: 'Write here',
    toolbar: {
      label: 'Format the selection',
      bold: 'Bold',
      italic: 'Italic',
      strike: 'Strikethrough',
      highlight: 'Highlight',
      code: 'Inline code',
      math: 'Inline math',
      link: 'Insert link',
    },
    link: {
      copy: 'Copy link',
      edit: 'Edit link',
      remove: 'Remove link',
      confirm: 'Apply link',
      input: 'Paste link…',
      copied: 'Link copied',
    },
  },
  table: {
    addRow: 'Add row',
    addColumn: 'Add column',
    deleteRow: 'Delete row',
    deleteColumn: 'Delete column',
    alignLeft: 'Align column left',
    alignCenter: 'Align column center',
    alignRight: 'Align column right',
  },
};

/** The ProseMirror view behind a handle: the tests look at what the user would see and type into. */
export const EditorViewOf = (editor: LiveEditor): EditorView =>
  (editor as unknown as { view: EditorView }).view;

export function options(over: Partial<LiveEditorOptions> = {}): LiveEditorOptions {
  return {
    paneId: 'test',
    readOnly: false,
    settings: { ...DEFAULT_LIVE_SETTINGS, spellcheck: false },
    labels,
    ariaLabel: 'Note editor',
    hotkey: () => undefined,
    onChange: () => undefined,
    onUpdate: () => undefined,
    onFocus: () => undefined,
    ...over,
  };
}

/** Opens a note in a Live editor on an element of the document; throws when the note is refused. */
export async function openLive(
  raw: string,
  over: Partial<LiveEditorOptions> = {},
): Promise<{ editor: LiveEditor; parent: HTMLElement; dispose(): void }> {
  const parent = document.body.appendChild(document.createElement('div'));
  const r = await openLiveEditor(parent, raw, options(over));
  if (!r.ok) {
    parent.remove();
    throw new Error(`refused: ${r.reason} ${'detail' in r ? (r.detail ?? '') : ''}`);
  }
  return {
    editor: r.editor,
    parent,
    dispose: () => {
      r.editor.dispose();
      parent.remove();
    },
  };
}
