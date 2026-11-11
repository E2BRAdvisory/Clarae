// The find bar of the Live editor (A-W5c): the frame the search of find.ts is driven from. It is the
// editor's own element, above the document and out of it (the document stays what the user edits), and
// every label is a translated string. Keys: Enter and Shift+Enter go to the next and previous match,
// Escape closes it and gives the keyboard back to the document.
import type { EditorView } from '@milkdown/kit/prose/view';
import { i18next } from '../../../i18n';
import { iconElement, type IconName } from '../../../shell/icons';
import {
  findKey,
  findNext,
  findStateOf,
  replaceAll,
  replaceCurrent,
  setFind,
  type FindState,
} from './find';

export interface FindBarHost {
  /** The element of the editor the bar goes in (it scrolls, the bar stays at its top). */
  parent: HTMLElement;
  view(): EditorView;
  readOnly(): boolean;
}

function button(label: string, icon: IconName | null, text?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  if (icon) b.append(iconElement(icon, 16));
  if (text) b.append(text);
  return b;
}

function field(label: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'text';
  i.setAttribute('aria-label', label);
  i.placeholder = label;
  i.autocomplete = 'off';
  i.spellcheck = false;
  return i;
}

export class FindBar {
  readonly element: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly replace: HTMLInputElement;
  private readonly caseButton: HTMLButtonElement;
  private readonly regexButton: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly replaceOne: HTMLButtonElement;
  private readonly replaceEvery: HTMLButtonElement;
  private isOpen = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: FindBarHost) {
    const el = document.createElement('div');
    el.className = 'live-find';
    el.setAttribute('role', 'search');
    el.setAttribute('aria-label', i18next.t('editor.find.label'));
    el.hidden = true;

    const top = document.createElement('div');
    top.className = 'live-find-row';
    this.search = field(i18next.t('editor.find.search'));
    this.caseButton = button(i18next.t('editor.find.matchCase'), null, 'Aa');
    this.regexButton = button(i18next.t('editor.find.regex'), null, '.*');
    for (const b of [this.caseButton, this.regexButton]) {
      b.classList.add('live-find-toggle');
      b.setAttribute('aria-pressed', 'false');
    }
    this.count = document.createElement('span');
    this.count.className = 'live-find-count';
    this.count.setAttribute('role', 'status');
    this.count.setAttribute('aria-live', 'polite');
    const prev = button(i18next.t('editor.find.previous'), 'arrowUp');
    const next = button(i18next.t('editor.find.next'), 'arrowDown');
    const close = button(i18next.t('editor.find.close'), 'close');
    top.append(this.search, this.caseButton, this.regexButton, this.count, prev, next, close);

    const bottom = document.createElement('div');
    bottom.className = 'live-find-row';
    this.replace = field(i18next.t('editor.find.replaceWith'));
    this.replaceOne = button(
      i18next.t('editor.find.replaceOne'),
      null,
      i18next.t('editor.find.replaceOne'),
    );
    this.replaceEvery = button(
      i18next.t('editor.find.replaceAll'),
      null,
      i18next.t('editor.find.replaceAll'),
    );
    bottom.append(this.replace, this.replaceOne, this.replaceEvery);

    el.append(top, bottom);
    this.element = el;
    host.parent.prepend(el);

    this.search.addEventListener('input', () => this.query({ search: this.search.value }));
    this.replace.addEventListener('input', () => this.query({ replace: this.replace.value }));
    this.caseButton.addEventListener('click', () => {
      const on = this.caseButton.getAttribute('aria-pressed') !== 'true';
      this.caseButton.setAttribute('aria-pressed', String(on));
      this.query({ caseSensitive: on });
    });
    this.regexButton.addEventListener('click', () => {
      const on = this.regexButton.getAttribute('aria-pressed') !== 'true';
      this.regexButton.setAttribute('aria-pressed', String(on));
      this.query({ regex: on });
    });
    prev.addEventListener('click', () => this.go(-1));
    next.addEventListener('click', () => this.go(1));
    close.addEventListener('click', () => this.close());
    this.replaceOne.addEventListener('click', () => this.replaceNow(false));
    this.replaceEvery.addEventListener('click', () => this.replaceNow(true));
    el.addEventListener('keydown', (e) => this.onKey(e));
  }

  private get view(): EditorView {
    return this.host.view();
  }

  private query(patch: Parameters<typeof setFind>[1]['query']): void {
    setFind(this.view, { query: patch ?? {} });
    this.refresh();
  }

  private go(dir: 1 | -1): void {
    findNext(this.view, dir);
    this.refresh();
  }

  private replaceNow(all: boolean): void {
    if (this.host.readOnly()) return;
    if (all) replaceAll(this.view);
    else replaceCurrent(this.view);
    this.refresh();
  }

  private onKey(e: KeyboardEvent): void {
    // The keys of the bar are its own: the application's hotkeys must not take them (the listener of
    // the host runs in the capture phase, before this one), except Escape and the bar's own commands.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'Enter' && e.target === this.search) {
      e.preventDefault();
      this.go(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Enter' && e.target === this.replace) {
      e.preventDefault();
      this.replaceNow(e.altKey || e.ctrlKey || e.metaKey);
    }
  }

  get opened(): boolean {
    return this.isOpen;
  }

  /** Shows the bar (with the selected text as the query, when there is some) and puts the caret in it. */
  open(seed?: string): void {
    this.isOpen = true;
    this.element.hidden = false;
    const current = findStateOf(this.view.state);
    if (seed) {
      this.search.value = seed;
      setFind(this.view, { open: true, query: { search: seed } });
    } else {
      this.search.value = current?.query.search ?? this.search.value;
      setFind(this.view, { open: true });
    }
    this.refresh();
    this.focusSearch();
    // A modal that closes (the command palette) gives the focus back to what had it before, a moment
    // after the command ran: the bar takes it once more when that is over.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.isOpen && !this.element.contains(document.activeElement)) this.focusSearch();
    }, 0);
  }

  private focusSearch(): void {
    this.search.focus();
    this.search.select();
  }

  /** Hides the bar, clears the matches and gives the keyboard back to the document. */
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.element.hidden = true;
    setFind(this.view, { open: false });
    this.view.focus();
  }

  /** Brings the figures and the buttons in step with the state of the search. */
  refresh(): void {
    if (!this.isOpen) return;
    const s: FindState | undefined = findStateOf(this.view.state);
    if (!s) return;
    const readOnly = this.host.readOnly();
    this.replace.disabled = readOnly;
    this.replaceOne.disabled = readOnly || s.matches.length === 0;
    this.replaceEvery.disabled = readOnly || s.matches.length === 0;
    this.search.setAttribute('aria-invalid', String(s.invalid));
    let text = '';
    if (s.invalid) text = i18next.t('editor.find.invalid');
    else if (s.query.search !== '') {
      if (s.matches.length === 0) text = i18next.t('editor.find.none');
      else if (s.current >= 0) {
        text = i18next.t('editor.find.position', { n: s.current + 1, total: s.matches.length });
      } else if (s.truncated) {
        text = i18next.t('editor.find.matchesAtLeast', { count: s.matches.length });
      } else text = i18next.t('editor.find.matches', { count: s.matches.length });
    }
    if (this.count.textContent !== text) this.count.textContent = text;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.isOpen = false;
    this.element.remove();
  }
}

export { findKey };
