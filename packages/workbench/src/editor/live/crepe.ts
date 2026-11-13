// The Crepe assembly of the Live editor (A-D6): a CrepeBuilder with the features of this wave, the
// Markdown layer of A-W3 on top, and the settings the A-W0 spike found necessary. Only the features
// that decide how a note is shown and written are on (code blocks, lists and tasks, tables, images,
// math, the drop cursor); the rich OFM views, the input and the frame (find, folding) are the application's
// own and come from the folders next to this file. The chrome of the playground (the toolbar over a selection,
// the tooltip of a link, the placeholder) is on with the names, icons and shortcuts of the application, and the
// handle of the blocks is built on the plugin of Milkdown (chrome/). Crepe's top bar, its AI and its slash menu
// stay off: the last has no translation, and the menu of the editor is the one of Source (input/suggest.ts).
import '@milkdown/crepe/theme/common/prosemirror.css';
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/image-block.css';
import '@milkdown/crepe/theme/common/latex.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/table.css';
import '@milkdown/crepe/theme/common/toolbar.css';
import './theme.css';
import './views/views.css';
import './input/input.css';
import './frame/frame.css';
import './chrome/chrome.css';
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { codeMirror, type CodeMirrorFeatureConfig } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { toolbar } from '@milkdown/crepe/feature/toolbar';
import { tableBlockConfig, type RenderType } from '@milkdown/kit/component/table-block';
import { editorViewOptionsCtx } from '@milkdown/kit/core';
import { uploadConfig } from '@milkdown/kit/plugin/upload';
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { createChrome, type ChromeLabels, type ShortcutOf } from './chrome';
import { installFrame } from './frame';
import { installInput, type LiveInputHost } from './input';
import { nameTaskBox } from './input/tasks';
import { installLive } from './kit';
import { EXTERNAL_META, isUserEdit } from './userEdit';
import { installViews, type LiveViewsHost } from './views';
import type * as EmojiChunk from './chunks/emoji';

/** The strings of the chrome that Crepe draws inside the document (code blocks, images). */
export interface CrepeLabels {
  copy: string;
  searchLanguage: string;
  noResult: string;
  previewEdit: string;
  previewHide: string;
  uploadFile: string;
  pasteLink: string;
  confirm: string;
  captionPlaceholder: string;
  /** The name of the field of a code block. */
  codeBlock: string;
  /** The name of the box of a task (a screen reader says it with its state). */
  task: string;
  /** The strings of the chrome around the document (chrome/). */
  chrome: ChromeLabels;
  /** The names of the icon buttons of a table (Crepe draws them without one). */
  table: {
    addRow: string;
    addColumn: string;
    deleteRow: string;
    deleteColumn: string;
    alignLeft: string;
    alignCenter: string;
    alignRight: string;
  };
}

/** What the adapter wants to hear of the view. */
export interface ViewHooks {
  /** A transaction went through; `docChanged` tells an edit (or a machine's change) from a selection. */
  update(docChanged: boolean, userEdit: boolean): void;
}

export interface CrepeOptions {
  root: HTMLElement;
  languages: NonNullable<CodeMirrorFeatureConfig['languages']>;
  /** The emoji chunk (chunks.ts): only a type is imported here, so that the chunk stays one of its own. */
  emoji: typeof EmojiChunk;
  labels: CrepeLabels;
  ariaLabel: string;
  spellcheck: boolean;
  /** The syntax colours and the tab width of the code blocks (they change with the theme: see the adapter). */
  codeTheme: NonNullable<CodeMirrorFeatureConfig['theme']>;
  /** Folding is on to begin with. */
  foldHeadings: boolean;
  /** The application, for the views of the constructs of the note (links, embeds, images, callouts…). */
  views: LiveViewsHost;
  /** What the user types, pastes and drops, and the application's answers to it (suggestions, attachments). */
  input: LiveInputHost;
  /** Stores a file the user picks in the empty image block, and answers the URL the image is written with. */
  upload: (file: File) => Promise<string>;
  /** Whether the editor refuses edits now (read on every transaction). */
  readOnly: () => boolean;
  /** The shortcut of a command of the registry, for the toolbar over a selection (none shown without it). */
  shortcut?: ShortcutOf;
  hooks: ViewHooks;
}

export { EXTERNAL_META, isUserEdit };

const readOnlyKey = new PluginKey('clarae-readonly');

/**
 * Builds the editor (not created yet). The read-only editor stays focusable and keeps its caret (the
 * status bar and the commands that read the selection need it): edits are refused by a filter, and
 * `editable` stays true (ADR-0049, A2 of the critique).
 */
export function buildCrepe(o: CrepeOptions): CrepeBuilder {
  const { labels } = o;
  const chrome = createChrome({
    labels: labels.chrome,
    readOnly: o.readOnly,
    slashEnabled: () => o.input.slash.enabled(),
    exec: (command) => o.input.exec(command),
    ...(o.shortcut ? { shortcut: o.shortcut } : {}),
  });
  const builder = new CrepeBuilder({ root: o.root, defaultValue: '' })
    .addFeature(codeMirror, {
      languages: o.languages,
      theme: o.codeTheme,
      copyText: labels.copy,
      searchPlaceholder: labels.searchLanguage,
      noResultText: labels.noResult,
      previewToggleText: (previewOnly) => (previewOnly ? labels.previewEdit : labels.previewHide),
    })
    .addFeature(listItem)
    .addFeature(table)
    .addFeature(imageBlock, {
      blockUploadButton: labels.uploadFile,
      blockUploadPlaceholderText: labels.pasteLink,
      blockConfirmButton: labels.confirm,
      blockCaptionPlaceholderText: labels.captionPlaceholder,
      inlineUploadButton: labels.uploadFile,
      inlineUploadPlaceholderText: labels.pasteLink,
      // Crepe's own uploader would make a `blob:` URL that the note could never open again: the file
      // is stored as an attachment of the vault, and the image is written with its path.
      onUpload: (file: File) => o.upload(file),
    })
    .addFeature(latex)
    .addFeature(toolbar, chrome.toolbar)
    .addFeature(linkTooltip, chrome.linkTooltip)
    .addFeature(placeholder, chrome.placeholder)
    // The native caret stays: a drawn one hides the IME's composition and the spellchecker's marks.
    .addFeature(cursor, { virtual: false });
  installLive(builder.editor);
  // after the features of Crepe: the views of the images replace the ones it brings
  installViews(builder.editor, o.views);
  installInput(builder.editor, o.input, { task: labels.task });
  installFrame(builder.editor, { foldHeadings: o.foldHeadings });
  chrome.install(builder.editor);
  builder.editor.use(o.emoji.emojiAsTyped);
  builder.editor.use(
    $prose(
      () =>
        new Plugin({
          key: readOnlyKey,
          filterTransaction: (tr) => !(o.readOnly() && isUserEdit(tr)),
        }),
    ),
  );
  builder.editor.config((ctx) => {
    o.emoji.twemojiLocal(ctx);
    nameTaskBox(ctx, labels.task);
    // the icon buttons of a table get a name a screen reader can read (the icon stays as it is)
    const tableNames: Partial<Record<RenderType, string>> = {
      add_row: labels.table.addRow,
      add_col: labels.table.addColumn,
      delete_row: labels.table.deleteRow,
      delete_col: labels.table.deleteColumn,
      align_col_left: labels.table.alignLeft,
      align_col_center: labels.table.alignCenter,
      align_col_right: labels.table.alignRight,
    };
    ctx.update(tableBlockConfig.key, (prev) => ({
      ...prev,
      renderButton: (type) => {
        const name = tableNames[type];
        return (
          prev.renderButton(type) +
          (name
            ? `<span class="live-sr">${name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</span>`
            : '')
        );
      },
    }));
    // The plugin that uploads what is dropped or pasted would make a `blob:` URL (see above): files go
    // through the smart paste of the input (input/paste.ts), which stores them as attachments, and with
    // that switched off they are not taken.
    ctx.update(uploadConfig.key, (prev) => ({ ...prev, uploader: () => Promise.resolve([]) }));
    ctx.update(editorViewOptionsCtx, (prev) => ({
      ...prev,
      attributes: {
        ...(typeof prev.attributes === 'object' ? prev.attributes : {}),
        'aria-label': o.ariaLabel,
        'aria-multiline': 'true',
        spellcheck: String(o.spellcheck),
        autocorrect: 'off',
      },
      // The view with every transaction applied (and the ones the plugins append): the adapter hears
      // whether it was an edit of the user. Every machine's housekeeping is `addToHistory: false`.
      dispatchTransaction(this: EditorView, tr) {
        const { state, transactions } = this.state.applyTransaction(tr);
        this.updateState(state);
        const docChanged = transactions.some((t) => t.docChanged);
        const userEdit = transactions.some(isUserEdit);
        if (docChanged || transactions.some((t) => t.selectionSet))
          o.hooks.update(docChanged, userEdit);
      },
    }));
  });
  return builder;
}
