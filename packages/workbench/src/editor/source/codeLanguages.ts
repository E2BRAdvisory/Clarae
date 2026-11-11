// The language chunk of the Live editor (A-D6): the CodeMirror language descriptions for its code blocks,
// and the theme and settings of the blocks (codeTheme.ts).
// It lives here because only this folder may import @codemirror/* (ADR-0049); the Live editor loads it
// with a dynamic import, so the descriptions (each language fetches its parser when a block first uses
// it) are a chunk of their own and never part of the entry.
export { languages } from '@codemirror/language-data';
export { codeExtensions } from './codeTheme';
