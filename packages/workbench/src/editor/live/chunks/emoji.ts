// The emoji chunk (A-D6): the input rule (`:smile:`) and the Twemoji view of plugin-emoji, which carries
// the emoji data. `remark-emoji` is left out on purpose: it rewrites `:smile:` to the character when a
// file is read, which would change the text of the note (B4 of the critique, measured by the A-W0 spike).
// Loaded with the editor, never by the entry (`loadEmoji`, chunks.ts: nothing imports this file but as a
// type, or the chunk would be folded into the editor's); the Twemoji images are served by the application.
//
// The images are Twemoji, Copyright Twitter, Inc. and other contributors, licensed CC-BY 4.0
// (https://creativecommons.org/licenses/by/4.0/); the code of the library is MIT. The builds with the
// Live editor copy them, with this attribution and the licence of the package, to `emoji/`
// (`copyTwemojiAssets`, build/esbuild.mjs).
import {
  emojiAttr,
  emojiSchema,
  insertEmojiInputRule,
  remarkTwemojiPlugin,
} from '@milkdown/plugin-emoji';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';

export const emojiAsTyped: MilkdownPlugin[] = [
  emojiAttr,
  remarkTwemojiPlugin,
  emojiSchema,
  insertEmojiInputRule,
].flat();

/** Where the application serves the Twemoji images from (never the CDN of the library: no request leaves). */
export const TWEMOJI = { base: '/emoji/', folder: 'svg', ext: '.svg' } as const;

/** Points the Twemoji view at the local images. */
export function twemojiLocal(ctx: Ctx): void {
  ctx.update(remarkTwemojiPlugin.options.key, (o) => ({ ...o, ...TWEMOJI }));
}
