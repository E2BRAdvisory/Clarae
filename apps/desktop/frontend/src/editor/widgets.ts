import { WidgetType, type EditorView } from '@codemirror/view';
import { livePreviewContext, type LinkSpec } from './context';

/** Checkbox for a task marker: toggles " " <-> "x" in the document. */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly state: string,
    readonly pos: number,
  ) {
    super();
  }
  override eq(o: CheckboxWidget): boolean {
    return o.state === this.state && o.pos === this.pos;
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-checkbox' + (this.state !== ' ' ? ' checked' : '');
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', String(this.state !== ' '));
    el.textContent =
      this.state === ' ' ? '' : this.state === 'x' || this.state === 'X' ? '✓' : this.state;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const next = this.state === ' ' ? 'x' : ' ';
      // pos points at "[": the state char is at pos + 1.
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: next } });
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-bullet';
    el.textContent = '•';
    return el;
  }
}

export class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-hr';
    return el;
  }
}

/** Inline or block math. */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  override eq(o: MathWidget): boolean {
    return o.tex === this.tex && o.display === this.display;
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-lp-math-block' : 'cm-lp-math';
    view.state.facet(livePreviewContext).renderMath(this.tex, this.display, el);
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  override eq(o: MermaidWidget): boolean {
    return o.code === this.code;
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-lp-mermaid';
    view.state.facet(livePreviewContext).renderMermaid(this.code, el);
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** An embedded note, image, PDF, audio or video: ![[x]] */
export class EmbedWidget extends WidgetType {
  constructor(readonly spec: LinkSpec) {
    super();
  }
  override eq(o: EmbedWidget): boolean {
    const a = this.spec;
    const b = o.spec;
    return (
      a.target === b.target && a.heading === b.heading && a.block === b.block && a.alias === b.alias
    );
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-embed';
    view.state.facet(livePreviewContext).renderEmbed(this.spec, el);
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** A Markdown image link: ![alt](path) */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  override eq(o: ImageWidget): boolean {
    return o.src === this.src && o.alt === this.alt;
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-embed';
    view.state.facet(livePreviewContext).renderImage(this.src, this.alt, el);
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const CALLOUT_ICONS: Record<string, string> = {
  note: '✎',
  abstract: '☰',
  summary: '☰',
  tldr: '☰',
  info: 'ℹ',
  todo: '☑',
  tip: '💡',
  hint: '💡',
  important: '🔥',
  success: '✔',
  check: '✔',
  done: '✔',
  question: '?',
  help: '?',
  faq: '?',
  warning: '⚠',
  caution: '⚠',
  attention: '⚠',
  failure: '✖',
  fail: '✖',
  missing: '✖',
  danger: '⚡',
  error: '⚡',
  bug: '🐞',
  example: '≡',
  quote: '❝',
  cite: '❝',
};

export function calloutIcon(type: string): string {
  return CALLOUT_ICONS[type.toLowerCase()] ?? '✎';
}

/** The title row of a callout: icon + title (+ fold chevron). */
export class CalloutTitleWidget extends WidgetType {
  constructor(
    readonly type: string,
    readonly title: string,
    readonly foldable: boolean,
    readonly folded: boolean,
    readonly titlePos: number,
    readonly onToggle: ((view: EditorView, pos: number) => void) | null,
  ) {
    super();
  }
  override eq(o: CalloutTitleWidget): boolean {
    return (
      o.type === this.type &&
      o.title === this.title &&
      o.foldable === this.foldable &&
      o.folded === this.folded &&
      o.titlePos === this.titlePos
    );
  }
  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-lp-callout-title';
    const icon = document.createElement('span');
    icon.className = 'cm-lp-callout-icon';
    icon.textContent = calloutIcon(this.type);
    const text = document.createElement('span');
    text.textContent = this.title || this.type.charAt(0).toUpperCase() + this.type.slice(1);
    el.append(icon, text);
    if (this.foldable) {
      const chev = document.createElement('span');
      chev.className = 'cm-lp-callout-chevron';
      chev.textContent = this.folded ? '▸' : '▾';
      chev.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.onToggle?.(view, this.titlePos);
      });
      el.append(chev);
    }
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}
