// Formatting commands (Mod-B, Mod-I, …). Each takes an EditorView and returns
// true when it acted. They are registered in the application command registry,
// which owns the hotkeys (customizable in Settings).
import { type ChangeSpec, EditorSelection, type SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** Wraps the selection with open/close, or unwraps it when already wrapped. */
export function toggleWrap(open: string, close = open) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const result = state.changeByRange((range: SelectionRange) => {
      const doc = state.doc;
      // Already wrapped just outside the selection?
      const before = doc.sliceString(Math.max(0, range.from - open.length), range.from);
      const after = doc.sliceString(range.to, Math.min(doc.length, range.to + close.length));
      if (before === open && after === close) {
        return {
          changes: [
            { from: range.from - open.length, to: range.from },
            { from: range.to, to: range.to + close.length },
          ] as ChangeSpec,
          range: EditorSelection.range(range.from - open.length, range.to - open.length),
        };
      }
      // Selection includes the markers.
      const text = doc.sliceString(range.from, range.to);
      if (
        text.length >= open.length + close.length &&
        text.startsWith(open) &&
        text.endsWith(close)
      ) {
        return {
          changes: [
            { from: range.from, to: range.from + open.length },
            { from: range.to - close.length, to: range.to },
          ] as ChangeSpec,
          range: EditorSelection.range(range.from, range.to - open.length - close.length),
        };
      }
      if (range.empty) {
        return {
          changes: { from: range.from, insert: open + close },
          range: EditorSelection.cursor(range.from + open.length),
        };
      }
      return {
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: close },
        ] as ChangeSpec,
        range: EditorSelection.range(range.from + open.length, range.to + open.length),
      };
    });
    view.dispatch(state.update(result, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

export const toggleBold = toggleWrap('**');
export const toggleItalic = toggleWrap('*');
export const toggleHighlight = toggleWrap('==');
export const toggleStrike = toggleWrap('~~');
export const toggleInlineCode = toggleWrap('`');
export const toggleComment = toggleWrap('%%');

/** [text](url) around the selection (url selected), or an empty [[wikilink]]. */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  if (r.empty) return insertWikilink(view);
  const text = state.doc.sliceString(r.from, r.to);
  const insert = `[${text}](url)`;
  view.dispatch({
    changes: { from: r.from, to: r.to, insert },
    selection: EditorSelection.range(r.from + text.length + 3, r.from + text.length + 6),
    userEvent: 'input',
  });
  return true;
}

export function insertWikilink(view: EditorView): boolean {
  const { state } = view;
  const r = state.selection.main;
  const text = state.doc.sliceString(r.from, r.to);
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: `[[${text}]]` },
    selection: EditorSelection.cursor(r.from + 2 + text.length),
    userEvent: 'input',
  });
  return true;
}

function eachSelectedLine(view: EditorView): { from: number; to: number; text: string }[] {
  const { state } = view;
  const seen = new Set<number>();
  const out: { from: number; to: number; text: string }[] = [];
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const l = state.doc.line(n);
      out.push({ from: l.from, to: l.to, text: l.text });
    }
  }
  return out;
}

const HEADING = /^(#{1,6})[ \t]+/;

/** Sets the heading level of the selected lines; the same level again removes it. */
export function setHeading(level: number) {
  return (view: EditorView): boolean => {
    const changes: ChangeSpec[] = [];
    for (const l of eachSelectedLine(view)) {
      const m = HEADING.exec(l.text);
      const current = m ? (m[1] ?? '').length : 0;
      const prefix = current === level ? '' : '#'.repeat(level) + ' ';
      changes.push({ from: l.from, to: l.from + (m ? m[0].length : 0), insert: prefix });
    }
    view.dispatch({ changes, userEvent: 'input' });
    return true;
  };
}

/** Prefix toggling for lists and quotes: adds the prefix, or removes it when all lines have it. */
function togglePrefix(prefix: string, detect: RegExp) {
  return (view: EditorView): boolean => {
    const lines = eachSelectedLine(view);
    const all = lines.every((l) => detect.test(l.text));
    const changes: ChangeSpec[] = lines.map((l) => {
      const m = detect.exec(l.text);
      return all && m
        ? { from: l.from, to: l.from + m[0].length, insert: '' }
        : { from: l.from, to: m ? l.from + m[0].length : l.from, insert: prefix };
    });
    view.dispatch({ changes, userEvent: 'input' });
    return true;
  };
}

export const toggleBulletList = togglePrefix('- ', /^[ \t]*[-*+][ \t]+/);
export const toggleNumberedList = togglePrefix('1. ', /^[ \t]*\d+[.)][ \t]+/);
export const toggleQuote = togglePrefix('> ', /^[ \t]*>[ \t]?/);

/** Turns lines into tasks: "- [ ] x" -> "- [x] x" -> plain text cycle on a task, adds "- [ ] " otherwise. */
export function toggleTask(view: EditorView): boolean {
  const changes: ChangeSpec[] = [];
  for (const l of eachSelectedLine(view)) {
    const task = /^([ \t]*[-*+][ \t]+)\[(.)\]([ \t]+)/.exec(l.text);
    if (task) {
      const state = task[2];
      const prefixEnd = l.from + (task[1] ?? '').length;
      if (state === ' ') changes.push({ from: prefixEnd + 1, to: prefixEnd + 2, insert: 'x' });
      else changes.push({ from: prefixEnd, to: l.from + task[0].length, insert: '' });
      continue;
    }
    const bullet = /^([ \t]*)[-*+][ \t]+/.exec(l.text);
    if (bullet)
      changes.push({
        from: l.from + (bullet[1] ?? '').length,
        to: l.from + bullet[0].length,
        insert: '- [ ] ',
      });
    else changes.push({ from: l.from, insert: '- [ ] ' });
  }
  view.dispatch({ changes, userEvent: 'input' });
  return true;
}
