// What the views of the Live editor (A-W5a) need from the application. They never import the API: they
// call the same `LivePreviewContext` the CodeMirror editor gets through its facet (resolving links,
// rendering embeds, images, math, diagrams and queries, opening links), and follow the link resolver.
import type { EmbedDisposer, LivePreviewContext } from '../../context';

export interface LiveViewsHost {
  /** The application's context, read when it is used (the pane's note, and so the context, can change). */
  context(): LivePreviewContext;
  /** Told when the resolution of some link changed (a note was created, renamed or deleted). */
  subscribe(cb: () => void): () => void;
}

const nothing = (): void => undefined;

/** The context of a host that renders everything as text and follows nothing. */
const plainContext: LivePreviewContext = {
  resolved: () => true,
  requestResolve: nothing,
  renderEmbed: (spec, el) => void (el.textContent = `![[${spec.target}]]`),
  renderImage: (src, alt, el) => void (el.textContent = alt || src),
  openLink: nothing,
  openExternal: nothing,
  renderMath: (tex, _display, el) => void (el.textContent = tex),
  renderMermaid: (code, el) => void (el.textContent = code),
};

/**
 * The host of an editor: the application's context, which the owner of the editor keeps current with
 * `use()`, and the link resolution, which it reports with `linksChanged()`.
 */
export class LiveHost implements LiveViewsHost {
  private readonly listeners = new Set<() => void>();

  constructor(private current: LivePreviewContext = plainContext) {}

  context(): LivePreviewContext {
    return this.current;
  }

  /** The application's context of the moment (the note's, and so the context, can change). */
  use(context: LivePreviewContext): void {
    this.current = context;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Some link resolves differently now: the views that show a link look again. */
  linksChanged(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

/** Frees what a render held: a function, or an object with `dispose()` (the two shapes of the context). */
export function release(d: EmbedDisposer | void | undefined): void {
  if (!d) return;
  if (typeof d === 'function') d();
  else d.dispose();
}

/**
 * Runs a render of the application into `el`. One that throws leaves `fallback` as the text of `el`:
 * the view of a construct must never be what takes the editor (and the note's text with it) down.
 */
export function safely<T>(el: HTMLElement, fallback: string, render: () => T): T | undefined {
  try {
    return render();
  } catch {
    el.textContent = fallback;
    return undefined;
  }
}
