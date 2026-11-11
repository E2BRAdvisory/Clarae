// The lazy chunks of the Live editor (A-D6). The entry loads none of them: the editor chunk (the React
// view, the adapter, the Crepe assembly, the fidelity layer) is fetched when a note first opens in Live,
// and it fetches the others from here. The structure is the final one, so that the waves that follow
// (views, input, frame, AI, collaboration) only add code to a chunk:
//
//   editor     MilkdownEditor.tsx and everything it imports (Milkdown, Crepe features, the layer)
//   languages  the CodeMirror language descriptions of the code blocks
//   emoji      the input rule and the Twemoji view (it carries the emoji data)
//   ai         Crepe's AI feature, diff and streaming: never loaded while the `ai` flag is off (A-W6)
//   collab     the Yjs binding: never loaded without the build constant, the `collab` flag AND a registered provider (A-W7); a build without the constant has a stub in its place (build/esbuild.mjs, liveCollab)
import { importWithRetry } from '../../ui/lazyView';

export const loadLanguages = () => importWithRetry(() => import('../source/codeLanguages'));
export const loadEmoji = () => importWithRetry(() => import('./chunks/emoji'));
export const loadAi = () => importWithRetry(() => import('./chunks/ai'));
export const loadCollab = () => importWithRetry(() => import('./chunks/collab'));
