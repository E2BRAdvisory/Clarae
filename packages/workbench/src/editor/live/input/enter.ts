// Enter over a selection that spans blocks. The key of the base keymap (`splitBlock`) deletes the selection
// and then splits at the place it had been computed for before the deletion: when the range took whole
// blocks with it (a table, a block of source, the items of a list) that place is gone, and the command
// throws (`TypeError`, `RangeError`) in the handler of the key. Here the range is deleted first, as the
// key does for a selection in one block, and the key goes on with the caret that is left: in a block of
// text it splits there, as it does for any caret; where no text is left to split (the range took the blocks
// down to the document) the key has nothing more to do.
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';

export const enterOverRange = (readOnly: () => boolean) =>
  $prose(
    () =>
      new Plugin({
        key: new PluginKey('clarae-enter-over-range'),
        props: {
          handleDOMEvents: {
            keydown(view, event) {
              if (event.key !== 'Enter' || event.isComposing) return false;
              if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
              const { selection } = view.state;
              if (selection.empty || readOnly()) return false;
              if (!(selection instanceof TextSelection)) return false;
              // inside one block the key does it right
              if (selection.$from.sameParent(selection.$to)) return false;
              view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
              if (view.state.selection.$from.parent.isTextblock) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
  );
