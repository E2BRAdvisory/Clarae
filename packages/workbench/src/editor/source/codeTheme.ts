// What the code blocks of the Live editor are made of, beyond Crepe's own: the colours of the syntax
// (one palette for the light theme and one for the dark, both on the surface of the block and above the
// contrast the application holds itself to), and the editor settings that reach them (the width of a
// tab). Like the language descriptions it lives here because only this folder imports @codemirror/*, and
// it comes with them in the language chunk (codeLanguages.ts).
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export interface Palette {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  fn: string;
  type: string;
  property: string;
  meta: string;
  invalid: string;
}

/** The colours of the syntax (exported for the contrast check of the tests). */
export const LIGHT: Palette = {
  keyword: '#6f42c1',
  string: '#116329',
  number: '#0550ae',
  comment: '#57606a',
  fn: '#6639ba',
  type: '#953800',
  property: '#0550ae',
  meta: '#0550ae',
  invalid: '#cf222e',
};

export const DARK: Palette = {
  keyword: '#ff7b72',
  string: '#a5d6ff',
  number: '#79c0ff',
  comment: '#8b949e',
  fn: '#d2a8ff',
  type: '#ffa657',
  property: '#79c0ff',
  meta: '#79c0ff',
  invalid: '#ff7b72',
};

const style = (p: Palette): HighlightStyle =>
  HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: p.keyword },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: p.string },
    { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: p.number },
    {
      tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
      color: p.comment,
      fontStyle: 'italic',
    },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)],
      color: p.fn,
    },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], color: p.type },
    { tag: [t.propertyName, t.attributeName, t.labelName], color: p.property },
    { tag: [t.meta, t.processingInstruction, t.annotation, t.heading], color: p.meta },
    { tag: t.heading, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.link, textDecoration: 'underline' },
    { tag: t.invalid, color: p.invalid },
  ]);

const LIGHT_STYLE = style(LIGHT);
const DARK_STYLE = style(DARK);

/** The syntax colours of a code block for the light or the dark theme. */
export const codeTheme = (dark: boolean): Extension =>
  syntaxHighlighting(dark ? DARK_STYLE : LIGHT_STYLE);

/**
 * The extension every code block of Live gets (Crepe adds it to its own and applies it to the blocks
 * that are open): the colours of the theme, the width of a tab (which is also what an indent is) and the
 * name of the field.
 */
export const codeExtensions = (o: {
  dark: boolean;
  tabSize: number;
  /** The accessible name of the code field (the editor of a block has none of its own). */
  label?: string;
}): Extension => [
  codeTheme(o.dark),
  EditorState.tabSize.of(o.tabSize),
  indentUnit.of(' '.repeat(o.tabSize)),
  // The base theme of CodeMirror tints the active line with a light translucent colour, which is too
  // light for the dark theme (the syntax colours stop reading on it): a block shows no active line.
  EditorView.theme(
    {
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    },
    { dark: o.dark },
  ),
  o.label ? EditorView.contentAttributes.of({ 'aria-label': o.label }) : [],
];
