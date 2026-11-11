// The input of the Live editor (A-W5b): what the user types, pastes and drops, and how the document
// answers. Installed by the real editor only (crepe.ts), after the views; the headless editor of the
// fidelity tests has no use for it. The pieces:
//
//   rules.ts      the Obsidian syntax typed as text becomes the node or mark the file has
//   refs.ts       footnote and link references, typed or pasted, become the atom of their source
//   bulk.ts       a text that comes whole is put in character by character, through the same rules
//   autopair.ts   brackets and quotes typed in pairs (the `autoPair` setting)
//   suggest.ts    the completion of links and tags, and the slash menu
//   paste.ts      smart paste and drop (attachments, links, rich HTML)
//   tasks.ts      the state of a task: the box of a custom state, the cycle of `editor:task`
//   enter.ts      Enter over a selection that spans blocks (the range is deleted, then the caret splits)
//   lists.ts      Alt+Up and Alt+Down move the items of a list and the blocks of the document;
//                 Tab and Shift+Tab indent as Source does (the items of a list, a tab elsewhere)
import type { Editor } from '@milkdown/kit/core';
import type { CompletionOptions } from '../../completionEngine';
import type { EditorCommand } from '../../handle';
import type { PasteDeps } from '../../pasteCore';
import type { SlashOptions } from '../../../slash/items';
import { autoPair } from './autopair';
import { bulkText } from './bulk';
import { enterOverRange } from './enter';
import { moveKeys, tabKeys } from './lists';
import { smartPaste } from './paste';
import { refRule } from './refs';
import { ofmInputRules, wikilinkEnter } from './rules';
import { suggestions } from './suggest';
import { listSemantics } from './listSemantics';
import { taskKeepsItsText, taskStates } from './tasks';

export { insertFiles } from './paste';
export { cycleTask, customState } from './tasks';
export { moveBlock } from './lists';

/** What the application gives the input of the editor (the settings and the backend are the application's). */
export interface LiveInputApp {
  completion: CompletionOptions;
  slash: SlashOptions;
  paste: PasteDeps;
  /** The `autoPair` setting, read at every key. */
  autoPair(): boolean;
  /** How long a key waits for the next one before the backend is asked for suggestions. */
  delayMs?: number;
}

/** What the editor adds: the state it is in and what it can do. */
export interface LiveInputHost extends LiveInputApp {
  readOnly(): boolean;
  /** Runs a command of the editor on the selection. */
  exec(command: EditorCommand): boolean;
}

/** An application that offers nothing: no suggestions, no smart paste, no auto-pairing. */
export const inertInput: LiveInputApp = {
  completion: {
    backend: { suggest: () => Promise.resolve([]), resolve: () => Promise.resolve('') },
    notePath: () => '',
    linkFormat: () => 'shortest',
  },
  slash: { enabled: () => false, run: () => undefined },
  paste: {
    saveAttachment: () => Promise.reject(new Error('no attachments')),
    enabled: () => false,
  },
  autoPair: () => false,
};

export function installInput(
  editor: Editor,
  host: LiveInputHost,
  labels: { task: string } = { task: '' },
): Editor {
  return (
    editor
      .use(bulkText)
      .use(ofmInputRules)
      .use(refRule)
      .use(taskStates(labels.task))
      .use(taskKeepsItsText)
      .use(listSemantics(labels.task))
      .use(moveKeys)
      .use(autoPair({ enabled: () => host.autoPair(), readOnly: () => host.readOnly() }))
      .use(suggestions(host))
      // after the suggestions: Enter chooses a candidate of their popup first
      .use(wikilinkEnter)
      // after the suggestions: Tab picks an item of their popup first
      .use(tabKeys(() => host.readOnly()))
      // Enter over a range that takes blocks with it: the range goes first, then the split of the caret
      .use(enterOverRange(() => host.readOnly()))
      .use(smartPaste({ deps: host.paste, readOnly: () => host.readOnly() }))
  );
}
