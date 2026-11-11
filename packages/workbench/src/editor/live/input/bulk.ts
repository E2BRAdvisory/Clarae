// Text that arrives in one piece (A-W5b). The input rules of ProseMirror act on what is typed one
// character at a time: they need the construct to END with the characters of the insertion, and a text
// that comes whole (a dictation, an emoji panel, an autocorrect, a test that fills the editor) has
// `[[Second]]` in its middle or in its whole, and would stay text, which the file writes escaped
// (`\[[Second]]`: no link). So a text that has a character an OFM construct is made of goes through the same
// way, one character after the other: the rules, and the editor's own handling of each character, see what
// they would have seen when it was typed. Pairing of brackets is not part of it (`bulk.active`: a text that
// came whole is not typed), and neither are composition (the IME's own insertion) and line breaks.
import { Plugin } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

/** True while a text is being put in character by character: what pairs what is typed leaves it alone. */
export const bulk = { active: false };

/** The characters the constructs of the rules are made of. */
const OFM_CHARS = /[[\]#=%^)]/;

export const bulkText = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          if (text.length < 2 || view.composing || /[\r\n]/.test(text) || !OFM_CHARS.test(text))
            return false;
          bulk.active = true;
          try {
            let start = from;
            let end = to;
            for (const ch of text) {
              const at = [start, end] as const;
              const taken = view.someProp('handleTextInput', (f) =>
                f(view, at[0], at[1], ch, () => view.state.tr.insertText(ch, at[0], at[1])),
              );
              if (!taken) view.dispatch(view.state.tr.insertText(ch, start, end));
              start = end = view.state.selection.from;
            }
          } finally {
            bulk.active = false;
          }
          return true;
        },
      },
    }),
);
