// What the caller tells the Markdown layer about the document being loaded.
import { $ctx } from '@milkdown/kit/utils';

export interface LiveOptions {
  /**
   * Start offsets (in the body) of blocks that must be kept raw although the layer could project
   * them: the ones whose written-again form is not the same note (see `unstableBlocks`).
   */
  forceRaw: ReadonlySet<number>;
}

export const liveOptions = $ctx<LiveOptions, 'liveOptions'>({ forceRaw: new Set() }, 'liveOptions');
