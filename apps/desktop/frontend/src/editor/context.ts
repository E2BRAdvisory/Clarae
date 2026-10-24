// The bridge between the CodeMirror extensions (pure UI) and the application
// (bindings, navigation): extensions never import the API, they call this
// context, which the Editor component provides through a facet.
import { Facet } from '@codemirror/state';

/** A wikilink or embed as the user wrote it. */
export interface LinkSpec {
  target: string;
  heading: string;
  block: string;
  /** Display text, or the size for embeds ("300" / "300x200"). */
  alias: string;
  embed: boolean;
}

export interface LivePreviewContext {
  /** true/false once known, undefined while still being resolved. */
  resolved(target: string): boolean | undefined;
  /** Asks the application to resolve a target; it calls onChange when done. */
  requestResolve(target: string): void;
  /** Fills el with the rendered embed (note, image, pdf, audio, video). */
  renderEmbed(spec: LinkSpec, el: HTMLElement): void;
  /** Fills el with an image from a Markdown image link. */
  renderImage(src: string, alt: string, el: HTMLElement): void;
  openLink(spec: LinkSpec, newTab: boolean): void;
  openExternal(url: string): void;
  /** Renders KaTeX into el (lazy-loaded). */
  renderMath(tex: string, display: boolean, el: HTMLElement): void;
  /** Renders a Mermaid diagram into el (lazy-loaded). */
  renderMermaid(code: string, el: HTMLElement): void;
  /** Renders a ```query block (embedded search) into el. */
  renderQuery?(source: string, el: HTMLElement): void;
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

export const livePreviewContext = Facet.define<LivePreviewContext, LivePreviewContext>({
  combine: (values) => values[values.length - 1] ?? defaultContext,
});
