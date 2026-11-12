// The bridge between the Live editor's views (pure UI) and the application (bindings, navigation):
// the views never import the API, they call this context, which NoteView provides (editor/live/views).
import type { LinkSpec } from './types';

// Moved to ./types (engine independent); re-exported so that the existing imports keep compiling.
export type { LinkSpec } from './types';

/** Frees what an embed render holds; a function or a render handle with dispose(). */
export type EmbedDisposer = (() => void) | { dispose(): void };

export interface LivePreviewContext {
  /** true/false once known, undefined while still being resolved. */
  resolved(target: string): boolean | undefined;
  /** Asks the application to resolve a target; it calls onChange when done. */
  requestResolve(target: string): void;
  /**
   * Fills el with the rendered embed (note, image, pdf, audio, video). May return what frees its
   * resources: the view calls it when the editor discards el (scrolled away, edited, closed).
   */
  renderEmbed(spec: LinkSpec, el: HTMLElement): EmbedDisposer | void;
  /** Fills el with an image from a Markdown image link (disposer as for renderEmbed). */
  renderImage(src: string, alt: string, el: HTMLElement): EmbedDisposer | void;
  openLink(spec: LinkSpec, newTab: boolean): void;
  openExternal(url: string): void;
  /** Renders KaTeX into el (lazy-loaded). */
  renderMath(tex: string, display: boolean, el: HTMLElement): void;
  /** Renders a Mermaid diagram into el (lazy-loaded). */
  renderMermaid(code: string, el: HTMLElement): void;
  /**
   * Renders a ```query block (embedded search) into el. May return what stops it following the index
   * (the views also stop it with `disposeQueryBlock(el)`).
   */
  renderQuery?(source: string, el: HTMLElement): EmbedDisposer | void;
}

const noop = (): void => undefined;

export const defaultContext: LivePreviewContext = {
  resolved: () => true,
  requestResolve: noop,
  renderEmbed: (spec, el) => {
    el.textContent = `![[${spec.target}]]`;
  },
  renderImage: (src, alt, el) => {
    el.textContent = alt || src;
  },
  openLink: noop,
  openExternal: noop,
  renderMath: (tex, _display, el) => {
    el.textContent = tex;
  },
  renderMermaid: (code, el) => {
    el.textContent = code;
  },
};
