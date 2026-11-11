// The views of the Live editor (A-W5a): what Obsidian's constructs look like in the document, and what
// the pointer does with them. Installed by the real editor only (crepe.ts), after Crepe's own features
// so that the views that replace theirs (the images) win; the headless editor of the fidelity tests
// has no use for a screen.
import type { Editor } from '@milkdown/kit/core';
import { calloutsPlugin } from './callouts';
import { activeDecorationsPlugin, baseDecorationsPlugin } from './decorations';
import { blocksPlugin } from './blocks';
import type { LiveViewsHost } from './host';
import { imageBlockView, imageInlineView } from './images';
import { rawBlockView, rawInlineView } from './raw';
import { wikilinkView } from './wikilink';

export { LiveHost, type LiveViewsHost } from './host';
export { attachInteractions, wikilinkUnder } from './interactions';

export function installViews(editor: Editor, host: LiveViewsHost): Editor {
  return editor
    .use(wikilinkView(host))
    .use(rawInlineView(host))
    .use(rawBlockView)
    .use(imageBlockView(host))
    .use(imageInlineView(host))
    .use(baseDecorationsPlugin)
    .use(calloutsPlugin)
    .use(blocksPlugin(host))
    .use(activeDecorationsPlugin);
}
