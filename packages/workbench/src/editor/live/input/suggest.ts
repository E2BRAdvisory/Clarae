// The suggestions of the Live editor (A-W5b): the completion of `[[links]]`, `[[note#headings]]`,
// `[[note#^blocks]]` and `#tags`, and the slash menu. One popup serves them. What is offered comes from
// the same places as in Source: the engine of completionEngine.ts (the ranking is the backend's, asked
// again at every key) and the list of slash/items.ts, with the same rules for where a "/" is just a
// character: code, math, links, URLs and the middle of a word. The setting `slashCommands` and a
// read-only note switch the menu off.
//
// The popup is opened by typing, never by the caret arriving somewhere or by a file loaded again (the
// plugin counts the edits of the user), and it follows what is in front of the caret: it closes when
// the text no longer asks for it. Up, Down, Enter, Tab and Escape drive it, Ctrl+Space asks for it (a
// `#` alone, for the tags). The editor keeps the focus the whole time: the list is `role=listbox`, and
// what is selected is announced by a live region.
//
// The pieces of the document it needs, in the order of the engine:
//   in a wikilink node   the text typed so far is the content of the node, and the choice replaces it
//   in plain text        `[[x`, `![[x`, `#x`, `/x` in front of the caret; a choice replaces them (a link
//                        becomes the node, a tag the text with the tag mark)
import i18next from 'i18next';
import {
  tagCandidates,
  wikilinkCandidates,
  WIKILINK_BEFORE,
  TAG_BEFORE,
  type Candidate,
  type CompletionOptions,
} from '../../completionEngine';
import type { EditorCommand } from '../../handle';
import {
  filterItems,
  slashLabel,
  slashMatch,
  todayText,
  type SlashItem,
  type SlashOptions,
} from '../../../slash/items';
import type { ResolvedPos } from '@milkdown/kit/prose/model';
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
} from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { chromeIcon, type ChromeIconName } from '../chrome/icons';
import { slashLook, type SlashGroup } from './slashLook';
import { isUserEdit } from '../userEdit';

export interface SuggestHost {
  completion: CompletionOptions;
  slash: SlashOptions;
  readOnly(): boolean;
  /** Runs a command of the editor on the selection (what a slash item of kind `exec` is). */
  exec(command: EditorCommand): boolean;
  /** How long a key waits for the next one before the backend is asked (the slash menu never waits). */
  delayMs?: number;
}

/** What is in front of the caret that asks for suggestions, and the part of the document a choice replaces. */
interface Trigger {
  kind: 'wikilink' | 'tag' | 'slash';
  /** The text the engine reads: for a wikilink, `[[` and what is typed. */
  before: string;
  /** The range a choice replaces. */
  from: number;
  to: number;
  /** For a wikilink: an embed, and the wikilink node the caret is in (null: plain text). */
  embed: boolean;
  node: { end: number } | null;
  query: string;
}

interface Choice {
  label: string;
  detail: string;
  /** The slash items only: the section of the menu they are in, and the icon beside them. */
  group?: SlashGroup;
  icon?: ChromeIconName;
  apply(view: EditorView, trigger: Trigger): void;
}

const SUGGEST_META = 'clarae-suggest';
/** A transaction with this meta arms the slash menu at a position (a number) or disarms it (null). */
const ARM_META = 'clarae-suggest-arm';

/**
 * What the plugin keeps: how many edits the user made (what opens the popup) and the position where the
 * slash menu was opened without a typed "/" (the block handle's "+"): the menu stays open while the text
 * from there to the caret is what a query is made of, and the query is that text.
 */
interface SuggestState {
  typed: number;
  armed: number | null;
}
const key = new PluginKey<SuggestState>('clarae-suggest');

/** The query typed since the slash menu was armed at `armed`, or null when the arming no longer holds. */
function armedQuery(state: EditorState, armed: number): string | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $pos = sel.$from;
  const { parent } = $pos;
  if (!parent.inlineContent || parent.type.spec.code) return null;
  if (armed < $pos.start() || armed > sel.from) return null;
  const typed = parent.textBetween(armed - $pos.start(), $pos.parentOffset);
  return /^[\p{L}\p{N}-]*$/u.test(typed) ? typed : null;
}

/**
 * Opens the slash menu at the caret, with nothing typed (the "+" of the block handle). Returns false when
 * the editor has no such menu. The menu closes as it does when typed: Escape, a click outside, or text
 * that is no query any more.
 */
export function armSlash(view: EditorView): boolean {
  if (!key.getState(view.state)) return false;
  view.dispatch(view.state.tr.setMeta(ARM_META, view.state.selection.from));
  return true;
}

/** The text right before `$pos` in its textblock: the text nodes up to the nearest node that is not text. */
function textBefore($pos: ResolvedPos): string {
  const { parent } = $pos;
  const base = $pos.start();
  let text = '';
  let bounded = false;
  parent.forEach((child, offset) => {
    const from = base + offset;
    if (from >= $pos.pos) return;
    if (child.isText) text += (child.text ?? '').slice(0, $pos.pos - from);
    else {
      text = '';
      bounded = true;
    }
  });
  // what a node left behind bounds a word, as the start of the text does
  return (
    (bounded && text === parent.textContent.slice(0, 0) ? '' : '') + (bounded ? '￼' : '') + text
  );
}

const inCode = (state: EditorState, $pos: ResolvedPos): boolean =>
  (state.storedMarks ?? $pos.marks()).some((m) => m.type.spec.code);

/** Where `/` is just a character: math, and the text of a link. Code is no textblock for this (see `triggerAt`). */
function protectedText(before: string): boolean {
  // an odd number of `$` in front: inside inline math
  return (before.split('$').length - 1) % 2 === 1;
}

/** The trigger at the caret, or null when nothing asks for suggestions there. */
function triggerAt(
  state: EditorState,
  host: SuggestHost,
): { trigger: Trigger; match: 'wikilink' | 'tag' | 'slash' } | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || host.readOnly()) return null;
  const $pos = sel.$from;
  const { parent } = $pos;
  if (parent.type.spec.code) return null;
  const pos = sel.from;

  if (parent.type.name === 'ofm_wikilink') {
    const typed = parent.textBetween(0, $pos.parentOffset);
    return {
      match: 'wikilink',
      trigger: {
        kind: 'wikilink',
        before: `[[${typed}`,
        from: $pos.start(),
        to: pos,
        embed: Boolean(parent.attrs['embed']),
        node: { end: $pos.end() },
        query: typed,
      },
    };
  }
  if (!parent.inlineContent || inCode(state, $pos)) return null;

  const before = textBefore($pos);
  const link = WIKILINK_BEFORE.exec(before);
  if (link) {
    const open = pos - (before.length - link.index);
    const embed = before.charAt(link.index - 1) === '!';
    const after = parent.textBetween(
      $pos.parentOffset,
      Math.min(parent.content.size, $pos.parentOffset + 2),
    );
    return {
      match: 'wikilink',
      trigger: {
        kind: 'wikilink',
        before,
        from: open - (embed ? 1 : 0),
        to: pos + (after === ']]' ? 2 : 0),
        embed,
        node: null,
        query: link[0].slice(2),
      },
    };
  }
  const tag = TAG_BEFORE.exec(before);
  if (tag) {
    const hash = tag[0].lastIndexOf('#');
    const typed = tag[0].slice(hash + 1);
    return {
      match: 'tag',
      trigger: {
        kind: 'tag',
        before,
        from: pos - typed.length - 1,
        to: pos,
        embed: false,
        node: null,
        query: typed,
      },
    };
  }
  const armed = key.getState(state)?.armed;
  if (host.slash.enabled() && armed != null) {
    const query = armedQuery(state, armed);
    if (query !== null) {
      return {
        match: 'slash',
        trigger: {
          kind: 'slash',
          before,
          from: armed,
          to: pos,
          embed: false,
          node: null,
          query,
        },
      };
    }
  }
  if (host.slash.enabled() && !protectedText(before)) {
    const m = slashMatch(before, before.length);
    if (m) {
      return {
        match: 'slash',
        trigger: {
          kind: 'slash',
          before,
          from: pos - (before.length - m.start),
          to: pos,
          embed: false,
          node: null,
          query: m.query,
        },
      };
    }
  }
  return null;
}

// ---- what a choice does ------------------------------------------------------------------------------------

/** A wikilink node (or the content of the one the caret is in) for a link text, the caret after it. */
function applyWikilink(view: EditorView, t: Trigger, insert: string): void {
  const { state } = view;
  const type = state.schema.nodes['ofm_wikilink'];
  if (!type) return;
  const tr = state.tr;
  let after: number;
  if (t.node) {
    tr.replaceWith(t.from, t.to, state.schema.text(insert));
    after = tr.mapping.map(t.node.end) + 1;
  } else {
    const node = type.create({ embed: t.embed }, state.schema.text(insert));
    tr.replaceWith(t.from, t.to, node);
    after = t.from + node.nodeSize;
  }
  tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
  view.dispatch(tr.setMeta(SUGGEST_META, true).scrollIntoView());
}

/** `#tag` as the text with the tag mark (a tag that is plain text would be written escaped). */
function applyTag(view: EditorView, t: Trigger, label: string): void {
  const { state } = view;
  const mark = state.schema.marks['ofm_tag'];
  const tr = state.tr.replaceWith(
    t.from,
    t.to,
    state.schema.text(`#${label}`, mark ? [mark.create()] : []),
  );
  view.dispatch(tr.setMeta(SUGGEST_META, true).scrollIntoView());
}

function applySlash(view: EditorView, t: Trigger, item: SlashItem, host: SuggestHost): void {
  // the typed "/query" goes first; then the item acts on the caret it leaves
  view.dispatch(view.state.tr.delete(t.from, t.to).setMeta(SUGGEST_META, true));
  if (item.exec) host.exec(item.exec);
  else if (item.command) host.slash.run(item.command);
  else if (item.id === 'date')
    view.dispatch(view.state.tr.insertText(todayText()).scrollIntoView());
  else if (item.insert) view.dispatch(view.state.tr.insertText(item.insert).scrollIntoView());
}

const fromCandidate = (c: Candidate): Choice => ({
  label: c.displayLabel ?? c.label,
  detail: c.detail ?? '',
  apply: (view, t) =>
    t.kind === 'tag' ? applyTag(view, t, c.insert) : applyWikilink(view, t, c.insert),
});

// ---- the popup ---------------------------------------------------------------------------------------------

let popups = 0;

class Suggestions {
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly id = `mb-suggest-${++popups}`;
  private choices: Choice[] = [];
  private index = 0;
  private shown: Trigger | null = null;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly host: SuggestHost,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'mb-suggest';
    this.el.hidden = true;
    this.list = document.createElement('div');
    this.list.className = 'mb-suggest-list';
    this.list.id = this.id;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', i18next.t('editor.suggest.label'));
    this.status = document.createElement('div');
    this.status.className = 'sr-only';
    this.status.setAttribute('role', 'status');
    this.el.append(this.list, this.status);
    // a click on the list does not take the focus from the editor
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    this.root().append(this.el);
  }

  /** The popup lives in the editor's host: it goes with it. */
  private root(): HTMLElement {
    return this.view.dom.closest<HTMLElement>('.live-host') ?? document.body;
  }

  get open(): boolean {
    return this.shown !== null;
  }

  /** Looks at what is in front of the caret now, and shows, updates or closes the popup. */
  evaluate(explicit = false, delay = true): void {
    clearTimeout(this.timer);
    const at = triggerAt(this.view.state, this.host);
    if (!at) return this.close();
    const seq = ++this.seq;
    const { trigger } = at;
    if (at.match === 'slash') return this.show(trigger, this.slashChoices(trigger.query));
    const run = (): void => {
      const o = this.host.completion;
      const asked =
        at.match === 'wikilink'
          ? wikilinkCandidates(trigger.before, o)
          : tagCandidates(trigger.before, explicit, o);
      asked.then(
        (set) => {
          if (this.destroyed || seq !== this.seq) return;
          if (!set || set.options.length === 0) return this.close();
          this.show(trigger, set.options.map(fromCandidate));
        },
        () => {
          // a backend that fails offers nothing: the typing goes on
          if (!this.destroyed && seq === this.seq) this.close();
        },
      );
    };
    const wait = this.host.delayMs ?? 60;
    if (!delay || wait <= 0) run();
    else this.timer = setTimeout(run, wait);
  }

  /** The items for a query, a group after the other (the groups in the order their best item comes). */
  private slashChoices(query: string): Choice[] {
    const items = filterItems(query).map((item) => ({ item, look: slashLook(item.id) }));
    const groups = [...new Set(items.map((i) => i.look.group))];
    return groups.flatMap((group) =>
      items
        .filter((i) => i.look.group === group)
        .map(({ item, look }): Choice => ({
          label: slashLabel(item),
          detail: '',
          group,
          ...(look.icon ? { icon: look.icon } : {}),
          apply: (view, t) => applySlash(view, t, item, this.host),
        })),
    );
  }

  private show(trigger: Trigger, choices: Choice[]): void {
    if (choices.length === 0) return this.close();
    // the same query keeps what was selected, a new one starts at the top
    this.index =
      this.shown && this.shown.query === trigger.query
        ? Math.min(this.index, choices.length - 1)
        : 0;
    this.shown = trigger;
    this.choices = choices;
    this.render();
    // shown first: its size is what the placement needs
    this.el.hidden = false;
    this.place(trigger.to);
  }

  private render(): void {
    let group: SlashGroup | undefined;
    this.list.replaceChildren(
      ...this.choices.flatMap((c, i) => {
        const nodes: HTMLElement[] = [];
        if (c.group && c.group !== group) {
          // the heading of a section is for the eye: the options keep their place in the one listbox
          const heading = document.createElement('div');
          heading.className = 'mb-suggest-group';
          heading.setAttribute('role', 'presentation');
          heading.setAttribute('aria-hidden', 'true');
          heading.textContent = i18next.t(`slash.group.${c.group}`);
          nodes.push(heading);
        }
        group = c.group;
        const row = document.createElement('div');
        row.className = 'mb-suggest-item';
        row.id = `${this.id}-${i}`;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === this.index));
        if (c.icon) {
          const icon = document.createElement('span');
          icon.className = 'mb-suggest-icon';
          icon.append(chromeIcon(c.icon, 20));
          row.append(icon);
        }
        const label = document.createElement('span');
        label.className = 'mb-suggest-label';
        label.textContent = c.label;
        row.append(label);
        if (c.detail) {
          const detail = document.createElement('span');
          detail.className = 'mb-suggest-detail';
          detail.textContent = c.detail;
          row.append(detail);
        }
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.index = i;
          this.accept();
        });
        nodes.push(row);
        return nodes;
      }),
    );
    const active = this.choices[this.index];
    this.status.textContent = active
      ? i18next.t('editor.suggest.status', {
          label: active.label,
          n: this.index + 1,
          count: this.choices.length,
        })
      : '';
    this.list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }

  private place(pos: number): void {
    try {
      const c = this.view.coordsAtPos(pos);
      const { el } = this;
      const width = el.offsetWidth || 280;
      const height = el.offsetHeight || 0;
      const below = c.bottom + 4;
      const top =
        below + height > window.innerHeight && c.top - 4 - height > 0 ? c.top - 4 - height : below;
      el.style.left = `${Math.max(8, Math.min(c.left, window.innerWidth - width - 8))}px`;
      el.style.top = `${top}px`;
    } catch {
      /* no layout (a test): the popup is where it is */
    }
  }

  move(by: number): void {
    const n = this.choices.length;
    if (!n) return;
    this.index = (this.index + by + n) % n;
    this.render();
  }

  accept(): void {
    const choice = this.choices[this.index];
    if (!choice) return;
    // the text may have moved on since the popup was drawn: what is asked for now decides
    const at = triggerAt(this.view.state, this.host);
    const shown = this.shown;
    this.close();
    if (!at || !shown || at.trigger.kind !== shown.kind) return;
    choice.apply(this.view, at.trigger);
    this.view.focus();
  }

  /** Forgets where the slash menu was armed (the popup is closed for good, not only for now). */
  disarm(): void {
    if (key.getState(this.view.state)?.armed != null)
      this.view.dispatch(this.view.state.tr.setMeta(ARM_META, null));
  }

  close(): void {
    clearTimeout(this.timer);
    ++this.seq;
    if (!this.shown) return;
    this.shown = null;
    this.choices = [];
    this.el.hidden = true;
    this.list.replaceChildren();
    this.status.textContent = '';
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.el.remove();
  }

  /** The keys of the open popup. true: handled. */
  key(event: KeyboardEvent): boolean {
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === ' ') {
      event.preventDefault();
      this.evaluate(true, false);
      return true;
    }
    if (!this.open) return false;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    switch (event.key) {
      case 'ArrowDown':
        if (!plain) return false;
        this.move(1);
        break;
      case 'ArrowUp':
        if (!plain) return false;
        this.move(-1);
        break;
      case 'Enter':
      case 'Tab':
        if (!plain) return false;
        this.accept();
        break;
      case 'Escape':
        this.close();
        this.disarm();
        break;
      default:
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
}

/** The suggestions of the editor: install it on the Live editor with `.use(suggestions(host))`. */
export const suggestions = (host: SuggestHost) =>
  $prose(() => {
    let ui: Suggestions | null = null;
    return new Plugin<SuggestState>({
      key,
      state: {
        init: () => ({ typed: 0, armed: null }),
        apply: (tr, value, _old, state) => {
          const typed = isUserEdit(tr) && !tr.getMeta(SUGGEST_META) ? value.typed + 1 : value.typed;
          let armed = value.armed;
          const meta = tr.getMeta(ARM_META) as number | null | undefined;
          // a choice made ends the arming, so that what is typed next is not a query
          if (meta !== undefined) armed = meta;
          else if (tr.getMeta(SUGGEST_META)) armed = null;
          else if (armed != null) armed = tr.mapping.map(armed, -1);
          if (armed != null && armedQuery(state, armed) === null) armed = null;
          return typed === value.typed && armed === value.armed ? value : { typed, armed };
        },
      },
      view(view) {
        ui = new Suggestions(view, host);
        return {
          update(v, prev) {
            const now = key.getState(v.state);
            const before = key.getState(prev);
            if (now?.typed !== before?.typed) ui?.evaluate();
            // armed: the menu opens with nothing typed
            else if (now?.armed != null && now.armed !== before?.armed) ui?.evaluate(false, false);
            else if (
              ui?.open &&
              (!prev.doc.eq(v.state.doc) || !prev.selection.eq(v.state.selection))
            )
              ui.evaluate(false, false);
          },
          destroy() {
            ui?.destroy();
            ui = null;
          },
        };
      },
      props: {
        handleDOMEvents: {
          keydown: (_view, event) => ui?.key(event) ?? false,
          blur: () => {
            ui?.close();
            ui?.disarm();
            return false;
          },
        },
      },
    });
  });
