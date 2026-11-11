// The upstream nodes that rewrite what the file says (B4 of the critique, measured by the spike), and
// the settings of the presets that would do the same. Each one is overridden with `extendSchema`,
// which the later registration wins.
//
//   image-block   `![schema](a.png)` became `![1.00](a.png)` and `![alt|300](a.png)` lost its size:
//                 the alt text is kept as the file has it (the `|300` is part of it).
//   code_block    the info string (`ts title="x"`) and the form of a Latex block (`$$` or a fence)
//                 are kept; Crepe's Latex feature turned every ```latex fence into `$$`.
//   paragraph     an empty paragraph is written as nothing, not as `<br />`.
//   list_item     a task whose first paragraph is empty but that holds other blocks is written without its box:
//                 the box is the text after the marker, and there is none (`- [ ]` then a line break is no
//                 task, and the serializer of the task list put the box after the line break, outside the item).
//                 The same for a text that starts with a line break (the next item after a split of a text of
//                 several lines): the line breaks at its start are not written, so the box is always on the
//                 line of the marker. An item with no text that holds blocks, task or not, has no blank line
//                 after its marker either (the blank line would end the item: `-`, a blank line, `  - a`).
//   emoji         `:smile:` and `a:b:c` stay as typed: remark-emoji is not installed (the input
//                 rule and the Twemoji view of plugin-emoji are enough); see chunks/emoji.ts.
//   emphasis,     the delimiter a mark was read with is kept (`_a_`); a mark made by editing has none,
//   strong        and takes the one the file uses (the schema's default, `*`, would not).
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import {
  codeBlockSchema,
  emphasisSchema,
  paragraphSchema,
  strongSchema,
} from '@milkdown/kit/preset/commonmark';
import { extendListItemSchemaForTask } from '@milkdown/kit/preset/gfm';
import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model';

export const imageBlockKeepsAlt = imageBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, alt: { default: '', validate: 'string' } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        state.addNode(type, {
          src: node['url'] as string,
          caption: (node['title'] as string | null) ?? '',
          ratio: 1,
          alt: (node['alt'] as string | null) ?? '',
        });
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.openNode('paragraph');
        state.addNode('image', undefined, undefined, {
          title: (node.attrs['caption'] as string) || null,
          url: node.attrs['src'] as string,
          alt: node.attrs['alt'] as string,
        });
        state.closeNode();
      },
    },
  };
});

export const codeBlockKeepsInfo = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: {
      ...base.attrs,
      meta: { default: '', validate: 'string' },
      form: { default: 'fence', validate: 'string' },
    },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const value = node['value'] as string;
        state.openNode(type, {
          language: (node['lang'] as string | null) ?? '',
          meta: (node['meta'] as string | null) ?? '',
          form: node['ofmForm'] === 'math' ? 'math' : 'fence',
        });
        if (value) state.addText(value);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const value = node.content.firstChild?.text ?? '';
        if (node.attrs['form'] === 'math') {
          state.addNode('math', undefined, value);
          return;
        }
        state.addNode('code', undefined, value, {
          lang: (node.attrs['language'] as string) || null,
          meta: (node.attrs['meta'] as string) || null,
        });
      },
    },
  };
});

export const paragraphWithoutBr = paragraphSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.openNode('paragraph');
        const last = node.lastChild;
        if (node.childCount >= 1 && last?.type.name === 'hardbreak') {
          const kids = [];
          for (let i = 0; i < node.childCount - 1; i++) kids.push(node.child(i));
          state.next(Fragment.fromArray(kids));
        } else {
          state.next(node.content);
        }
        state.closeNode();
      },
    },
  };
});

/**
 * Whether a paragraph says no text for the file: it is empty or made of line breaks only (a line break
 * typed at the start of an item, then a block pasted after it: the paragraph that holds the line break is
 * cut from the text that follows). The serializer writes such a paragraph as nothing.
 */
export function saysNoText(paragraph: PMNode): boolean {
  for (let i = 0; i < paragraph.childCount; i++) {
    if (paragraph.child(i).type.name !== 'hardbreak') return false;
  }
  return true;
}

/** The paragraph `head` without the line breaks it starts with: no text of a task starts on a line of its own. */
function withoutLeadingBreaks(head: PMNode): PMNode {
  let at = 0;
  while (at < head.childCount) {
    const k = head.child(at);
    const soft = k.type.name === 'hardbreak' && k.attrs['isInline'] === true;
    if (!soft && !(k.isText && /^[\r\n]/.test(k.text ?? ''))) break;
    at++;
  }
  const first = head.maybeChild(at);
  const rest: PMNode[] = [];
  if (first?.isText) {
    const text = (first.text ?? '').replace(/^[\r\n]+/, '');
    if (text) rest.push(first.type.schema.text(text, first.marks));
    at++;
  }
  for (let i = at; i < head.childCount; i++) rest.push(head.child(i));
  return head.type.create(head.attrs, Fragment.fromArray(rest), head.marks);
}

/** Whether a block of `item` is a list whose first item is empty, and a text block comes right before it. */
function startsEmptyListAfterText(item: PMNode): boolean {
  let found = false;
  item.forEach((k, _o, i) => {
    const before = i > 0 ? item.child(i - 1) : null;
    if (!before || !['paragraph', 'table', 'blockquote', 'raw_block'].includes(before.type.name)) {
      return;
    }
    if (k.type.name !== 'bullet_list' && k.type.name !== 'ordered_list') return;
    const first = k.firstChild?.firstChild;
    if (first?.type.name === 'paragraph' && first.content.size === 0) found = true;
  });
  return found;
}

export const taskWithoutTextHasNoBox = extendListItemSchemaForTask.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const old = node.firstChild;
        if (old?.type.name !== 'paragraph') {
          base.toMarkdown.runner(state, node);
          return;
        }
        // the box is written after the marker, on its line: a text that starts with a line break would
        // have it on the next one (`-`, a line break, `[x]`), which no task is
        const head = node.attrs['checked'] == null ? old : withoutLeadingBreaks(old);
        let item = head === old ? node : node.copy(node.content.replaceChild(0, head));
        // a list that starts with an empty item (`-`, `1.`) right under a line of text is no list: a bare `-`
        // is the underline of a heading, an empty `1.` is text; a blank line keeps it what it is
        if (startsEmptyListAfterText(item) && item.attrs['spread'] !== true) {
          item = item.type.create({ ...item.attrs, spread: true }, item.content, item.marks);
        }
        if (item.childCount < 2 || !saysNoText(head)) {
          base.toMarkdown.runner(state, item);
          return;
        }
        // An item with no text that holds blocks has no box, and no blank line after its marker either:
        // the blank line would end the item (`-`, a blank line, `  - a` is an empty item and a list
        // after it), and what the editor shows nested would be, when the note is opened again, not.
        // A paragraph that follows the empty one is the text of the item for the file (two paragraphs are
        // always a blank line apart): the empty one is not written.
        // The blank line the empty one would have left after the marker is the only one to avoid: when the
        // paragraph is the text, the item is as wide as it was (a blank line between the text and the list
        // that follows is what keeps `2. x` and a bare `-` from being text of the paragraph and its underline).
        const textFirst = item.child(1).type.name === 'paragraph';
        const rest = textFirst ? item.content.cut(head.nodeSize) : item.content;
        state.openNode('listItem', undefined, {
          label: item.attrs['label'] as string,
          listType: item.attrs['listType'] as string,
          spread: textFirst && item.attrs['spread'] === true,
        });
        state.next(rest);
        state.closeNode();
      },
    },
  };
});

const noDefaultMarker = {
  marker: { default: '', validate: 'string' },
};

export const emphasisUsesFileStyle = emphasisSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  attrs: noDefaultMarker,
}));

export const strongUsesFileStyle = strongSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  attrs: noDefaultMarker,
}));
