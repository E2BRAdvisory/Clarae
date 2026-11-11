// A Live editor without a screen: the same plugins as the real one (the CrepeBuilder set and the
// Markdown layer), mounted on a detached element, used to parse and serialize. It is what the tests
// of the layer and the conformance suite run; the real editor (A-W4) adds the views on top.
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { table } from '@milkdown/crepe/feature/table';
import { installDomShims } from './domShims';
import { loadEmoji } from './chunks';
import { installLive } from './kit';
import { captureSurface, type EditorSurface } from './surface';

/** The headless editor: the surface of the layer, and its own teardown. */
export interface LiveCore extends EditorSurface {
  destroy(): Promise<void>;
}

/** The Crepe features that decide the schema and the Markdown of the document (no chrome). */
export function addSchemaFeatures(builder: CrepeBuilder): CrepeBuilder {
  return builder
    .addFeature(codeMirror)
    .addFeature(listItem)
    .addFeature(table)
    .addFeature(imageBlock)
    .addFeature(latex);
}

export async function createLiveCore(defaultValue = ''): Promise<LiveCore> {
  installDomShims();
  const host = document.createElement('div');
  document.body.append(host);
  const builder = addSchemaFeatures(new CrepeBuilder({ root: host, defaultValue }));
  installLive(builder.editor).use((await loadEmoji()).emojiAsTyped);
  const surfaceOf = captureSurface(builder.editor);
  await builder.create();
  return {
    ...surfaceOf(),
    destroy: async () => {
      await builder.destroy();
      host.remove();
    },
  };
}
