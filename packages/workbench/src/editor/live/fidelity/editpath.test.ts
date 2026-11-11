// The edit path against the forced one, on the edits that were found to make them differ: the text
// the layer writes after an edit must mean what the editor shows (the same Markdown tree, the same
// extract() entry with no positions, the same Reading HTML) and what writing every block again says.
// Each case is an edit a user can make (a paste, Backspace, Enter, a block type changed), not a
// transaction built by hand; the key names the construct and the operation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Slice, type Node as PMNode } from '@milkdown/kit/prose/model';
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import {
  joinBackward,
  lift,
  selectNodeBackward,
  chainCommands,
  deleteSelection,
  wrapIn,
} from '@milkdown/kit/prose/commands';
import { liftListItem } from '@milkdown/kit/prose/schema-list';
import { createLiveCore, type LiveCore } from '../headless';
import { renderMarkdown } from '../../../reading/render';
import { shape } from '../testing/metrics';
import { open, posAfter, tx } from '../testing/helpers';

let core: LiveCore;
beforeAll(async () => {
  core = await createLiveCore();
});
afterAll(() => core.destroy());

type Op = (doc: PMNode) => Transaction;

const ws = (s: string): string => s.replace(/\s+/g, ' ').trim();
const tree = (md: string): string => {
  try {
    return JSON.stringify(core.parseTree(md.replace(/^\uFEFF/, '')), (k, v: unknown) =>
      k === 'position' ? undefined : v,
    );
  } catch {
    return 'THROWS';
  }
};
const html = (md: string): string => ws(renderMarkdown(md));

const blockAt = (doc: PMNode, k: number): number => {
  let at = 0;
  for (let i = 0; i < k; i++) at += doc.child(i).nodeSize;
  return at;
};
const parseBlocks = (md: string): PMNode => core.parse(md + '\n');
const insertAtEnd =
  (md: string): Op =>
  (doc) =>
    tx(doc).insert(doc.content.size, parseBlocks(md).content);
const insertBefore =
  (k: number, md: string): Op =>
  (doc) =>
    tx(doc).insert(blockAt(doc, k), parseBlocks(md).content);
const deleteBlock =
  (k: number): Op =>
  (doc) =>
    tx(doc).delete(blockAt(doc, k), blockAt(doc, k + 1));
const typeBefore =
  (text: string, ch: string): Op =>
  (doc) =>
    tx(doc).insertText(ch, posAfter(doc, text) - text.length);
const typeAfterText =
  (text: string, ch: string): Op =>
  (doc) =>
    tx(doc).insertText(ch, posAfter(doc, text));
const deleteChar =
  (text: string): Op =>
  (doc) =>
    tx(doc).delete(posAfter(doc, text) - 1, posAfter(doc, text));
const splitAfter =
  (text: string, depth = 1): Op =>
  (doc) =>
    tx(doc).split(posAfter(doc, text), depth);
const insertInFirstItem =
  (md: string): Op =>
  (doc) => {
    let at = -1;
    doc.descendants((n, pos) => {
      if (at < 0 && n.type.name === 'list_item') at = pos + 1 + n.child(0).nodeSize;
      return true;
    });
    return tx(doc).insert(at, parseBlocks(md).content);
  };
const command =
  (
    text: string,
    cmd: () => (s: EditorState, d?: (tr: Transaction) => void) => boolean,
    offset = 0,
  ): Op =>
  (doc) => {
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, posAfter(doc, text) + offset),
    });
    let out: Transaction | null = null;
    cmd()(state, (tr) => {
      out = tr;
    });
    if (!out) throw new Error('the command did nothing');
    return out;
  };
/** Text pasted as closed blocks right before `text` (the paragraph that holds it is split there). */
const pasteBefore =
  (text: string, md: string): Op =>
  (doc) => {
    const at = posAfter(doc, text) - text.length;
    return tx(doc).replace(at, at, new Slice(parseBlocks(md).content, 0, 0));
  };
/** `text` deleted, and Enter pressed in the paragraph that is left empty. */
const clearAndEnter =
  (text: string): Op =>
  (doc) => {
    const to = posAfter(doc, text);
    const t = tx(doc).delete(to - text.length, to);
    return t.split(to - text.length);
  };
/** Backspace at the very start of the top-level block `k`. */
const backspaceAtStart =
  (k: number): Op =>
  (doc) => {
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, blockAt(doc, k) + 1),
    });
    let out: Transaction | null = null;
    joinBackward(state, (t) => {
      out = t;
    });
    if (!out) throw new Error('the command did nothing');
    return out;
  };
/** Enter at the end of the top-level block `k`. */
const enterAtEnd =
  (k: number): Op =>
  (doc) =>
    tx(doc).split(blockAt(doc, k + 1) - 1);
/** Blocks inserted at the end of the top-level container `k` (a quote). */
const insertInto =
  (k: number, md: string): Op =>
  (doc) =>
    tx(doc).insert(blockAt(doc, k + 1) - 1, parseBlocks(md).content);
/** The text between two positions of the first paragraph deleted. */
const clearText =
  (from: number, to: number): Op =>
  (doc) =>
    tx(doc).delete(from, to);
const toParagraph: Op = (doc) => tx(doc).setBlockType(1, 1, core.schema.nodes['paragraph']!);
const nodeOf = (name: string) => core.schema.nodes[name]!;

interface Case {
  raw: string;
  op: Op;
  /** The text read again is not the blocks of the document (a placeholder paragraph, a reference that became text). */
  noOutline?: true;
}

const CASES: Record<string, Case> = {
  // a block that does not end by itself and the rule or the heading underline that follows it
  'math/insert-hr-after': { raw: '$$\nx^2\n$$\n', op: insertAtEnd('---') },
  'math/insert-setext-after': { raw: '$$\nx^2\n$$\n', op: insertAtEnd('Setext\n---') },
  'table/insert-hr-after': {
    raw: '| a | b |\n|---|---|\n| 1 | 2 |\n',
    op: insertAtEnd('---'),
  },
  'math/insert-before-tight-hr': { raw: '# Head\n---\n', op: insertBefore(1, '$$\nx\n$$') },
  'table/insert-before-tight-hr': {
    raw: '# Head\n---\n',
    op: insertBefore(1, '| a | b |\n|---|---|\n| 1 | 2 |'),
  },
  'math/insert-before-tight-setext': {
    raw: '# Head\nSetext\n======\n',
    op: insertBefore(1, '$$\nx\n$$'),
  },
  'list-item/empty-after-table': {
    raw: '| a | b |\n|---|---|\n| 1 | 2 |\n- x\n',
    op: deleteChar('x'),
  },
  'list-item/empty-after-paragraph': { raw: 'text\n- x\n', op: deleteChar('x') },
  'ordered-item/empty-after-paragraph': { raw: 'text\n1. x\n', op: deleteChar('x') },
  // the text of a block the edit did not touch is read in another context
  'indented-code+numbered-para/delete-code': {
    raw: '    code\n\n5. a\n6. b\n',
    op: deleteBlock(0),
  },
  'fence-indented/delete-previous-block': {
    raw: 'a\n\nmid\n\n  ```\n  c\n  ```\n',
    op: deleteBlock(1),
  },
  'math-indented/delete-previous-block': {
    raw: 'a\n\nmid\n\n  $$\n  x\n  $$\n',
    op: deleteBlock(1),
  },
  'list-indented/delete-previous-block': {
    raw: 'a\n\nmid\n\n   - a\n   - b\n',
    op: deleteBlock(1),
  },
  'linkdef/insert-after-ref-text': {
    raw: 'see [ref] here\n',
    op: insertAtEnd('[ref]: http://x.y'),
  },
  'linkdef/insert-far-from-ref-text': {
    raw: 'see [ref] here\n\nmid\n\nlast\n',
    op: insertAtEnd('[ref]: http://x.y'),
  },
  'linkdef/insert-after-ref-text-in-callout': {
    raw: '> [!note] Title\n> see [ref] here\n',
    op: insertAtEnd('[ref]: http://x.y'),
  },
  'linkdef/delete': {
    raw: 'see [ref] here\n\n[ref]: http://x.y\n\nlast\n',
    op: deleteBlock(1),
    noOutline: true,
  },
  // lists that touch
  'list/insert-between-list-and-raw-list': {
    raw: '+ a\n\n- 1) a\n  2) b\n',
    op: insertBefore(1, '- new'),
  },
  'list/split-list-when-next-list-has-other-marker': {
    raw: '- a\n- b\n* c\n',
    op: splitAfter('a', 3),
  },
  'list/split-ordered-list-when-next-list-has-other-delimiter': {
    raw: '1. foo\n2. bar\n3) baz\n',
    op: splitAfter('fo', 3),
  },
  'list/split-task-lists': {
    raw: '- [ ] a\n  - [ ] b\n- [x] c\n\n1. [ ] d\n',
    op: splitAfter('c', 3),
  },
  // the indentation of the place a new block goes to
  'comment/insert-in-item-in-quote': {
    raw: '> - a\n>\n>     more\n',
    op: insertInFirstItem('%%\nhidden\n%%'),
  },
  'comment/insert-in-item': { raw: '- a\n\n      more\n', op: insertInFirstItem('%%\nhidden\n%%') },
  // Reading does not see a fence indented four or more inside an item: `%%` there opens a comment
  'fence-4sp-in-item/type-percent-percent': {
    raw: '- foo\n\n    ```\n    bar\n    ```\n\n  baz\n',
    op: typeBefore('bar', '%%'),
  },
  'fence-4sp-in-ordered-item/type-percent-percent': {
    raw: '1.  a\n\n    ```\n    x\n    ```\n\nafter\n',
    op: typeAfterText('x', '%%'),
  },
  'frontmatter-dots/insert-para': {
    raw: '---\ntitle: A\n...\n',
    op: insertAtEnd('para text'),
    noOutline: true,
  },
  'frontmatter-without-line-end/insert-para': {
    raw: '---\ntitle: A\n---',
    op: insertAtEnd('para text'),
    noOutline: true,
  },
  // a comment is nothing to Reading: the lists on its two sides touch there
  'comment/insert-between-lists': {
    raw: '- a\n- b\n* c\n',
    op: insertBefore(1, '%%\nc\n%%'),
  },
  'inline-comment/insert-between-lists': {
    raw: '* a\n* b\n\n- c\n- d\n',
    op: insertBefore(1, '%% inline %%'),
  },
  // a block type changed or a block lifted, next to a block with no blank line
  'heading/to-paragraph-before-tight-paragraph': { raw: '# H\nnext\n', op: toParagraph },
  'fence/to-paragraph-before-tight-paragraph': {
    raw: '```\ncode\n```\nnext\n',
    op: toParagraph,
  },
  'math/to-paragraph-before-tight-paragraph': { raw: '$$\nx\n$$\ntext\n', op: toParagraph },
  'quote/lift-before-tight-hr': { raw: '> Foo\n---\n', op: command('Foo', () => lift) },
  'quote/backspace-before-tight-hr': {
    raw: '> Foo\n---\n',
    op: command('Foo', () => chainCommands(deleteSelection, joinBackward, selectNodeBackward), -3),
  },
  'item/lift-before-tight-hr': {
    raw: '- Foo\n---\n',
    op: command('Foo', () => liftListItem(nodeOf('list_item'))),
  },
  'list-item/lift-quote-before-tight-list': { raw: '- a\n> q\n', op: command('q', () => lift) },
  'paragraph/wrap-in-quote-before-tight-quote': {
    raw: 'foo\n> bar\n',
    op: command('foo', () => wrapIn(nodeOf('blockquote'))),
  },
  'paragraph/wrap-in-quote-before-tight-table': {
    raw: 'a\n| x | y |\n|---|---|\n| 1 | 2 |\nb\n',
    op: command('a', () => wrapIn(nodeOf('blockquote'))),
  },
  // a fence run typed or left in a code block: Reading closes a fence at ANY line that starts with a
  // run of the fence character, so a comment a few blocks further is read otherwise than in the file
  'fence/type-fence-run-at-line-start-then-distant-comment': {
    raw: '```\nx\n```\n\nm\n\n%%\nc\n%%\n',
    op: typeBefore('x', '```'),
  },
  'fence/type-tilde-run-at-line-start-then-distant-comment': {
    raw: '~~~\nx\n~~~\n\nm\n\n%%\nc\n%%\n',
    op: typeBefore('x', '~~~'),
  },
  'fence/type-fence-run-in-item-then-distant-comment': {
    raw: '- a\n\n  ```\n  x\n  ```\n\nm\n\n%%\nc\n%%\n',
    op: typeBefore('x', '```'),
  },
  'fence/type-fence-run-then-distant-inline-comment': {
    raw: '```\nx\n```\n\nm\n\n%%cc%% text\n',
    op: typeBefore('x', '```'),
  },
  'fence/enter-before-fence-run-in-code-line': {
    raw: '```\na```b\n```\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('a', '\n'),
  },
  'fence/type-newline-fence-run-in-code-line': {
    raw: '```\na```b\n```\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('a', '\n```q\n'),
  },
  'fence/type-newline-fence-run-3-spaces': {
    raw: '```\nab\n```\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('a', '\n   ```q\n'),
  },
  'fence-4/type-newline-four-backticks': {
    raw: '````\nab\n````\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('a', '\n````q\n'),
  },
  'fence-3/type-newline-six-backticks': {
    raw: '```\nab\n```\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('a', '\n``````q\n'),
  },
  'fence/edit-elsewhere-with-fence-run-line-in-code': {
    raw: '```\n```x\n```\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('m', 'y'),
  },
  'fence/edit-elsewhere-with-spaced-fence-run-in-paragraph': {
    raw: '``` ```\naaa\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('m', 'y'),
  },
  'fence/edit-elsewhere-with-fence-run-inline-code-paragraph': {
    raw: '``` aa ```\nfoo\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('m', 'y'),
  },
  'fence/edit-elsewhere-with-unclosed-fence-run-paragraph': {
    raw: '```foo``\n\nm\n\n%%\nc\n%%\n',
    op: typeAfterText('m', 'y'),
  },
  // what Reading prepares (`%%`, `\\[[`, `\\^[`) is read against the indentation the item has
  'ordered-list-wide-marker/edit-elsewhere-before-leading-inline-comment': {
    raw: 'm\n\n1.  a\n\n%%cc%% text\n',
    op: typeAfterText('m', 'y'),
  },
  'ordered-list-zeros/edit-elsewhere-before-leading-inline-comment': {
    raw: 'm\n\n003. ok\n\n%%cc%% text\n',
    op: typeAfterText('m', 'y'),
  },
  'list-spread-indent/edit-elsewhere-before-leading-inline-comment': {
    raw: 'm\n\n-  foo\n\n   bar\n\n%%cc%% text\n',
    op: typeAfterText('m', 'y'),
  },
  'paragraph/edit-elsewhere-escaped-backslash-before-inline-footnote': {
    raw: 'm\n\nx \\\\^[a] y\n',
    op: typeAfterText('m', 'y'),
  },
  'paragraph/edit-elsewhere-escaped-backslash-before-wikilink': {
    raw: 'm\n\nx \\\\[[c]] y\n',
    op: typeAfterText('m', 'y'),
  },
  // lists of other markers that Reading sees side by side because what is between them is nothing
  'list/paste-list-between-lists-of-other-marker': {
    raw: '* a\n\nm\n\n- a\n- b\n',
    op: pasteBefore('m', '- a\n- b'),
    noOutline: true,
  },
  'paragraph/clear-and-enter-between-lists-of-other-marker': {
    raw: '- a\n\nm\n\n* b\n',
    op: clearAndEnter('m'),
    noOutline: true,
  },
  'paragraph/clear-and-enter-between-task-list-and-list': {
    raw: '- [ ] t\n\nm\n\n* a\n',
    op: clearAndEnter('m'),
    noOutline: true,
  },
  'paragraph/clear-and-enter-between-list-and-task-list': {
    raw: '* a\n\nm\n\n- [ ] t\n',
    op: clearAndEnter('m'),
    noOutline: true,
  },
  'comment-between-lists/insert-comment-before-comment': {
    raw: '- a\n\n%% c %%\n\n- b\n',
    op: insertBefore(1, '%% inline %%'),
  },
  'comment-between-lists/append-list-after-two-comments': {
    raw: '- a\n\n%% c %%\n\n%% d %%\n',
    op: insertAtEnd('- [ ] t'),
  },
  'comment-between-lists/append-ordered-list-after-two-comments': {
    raw: '1. a\n\n%% c %%\n\n%% d %%\n',
    op: insertAtEnd('1. t'),
  },
  'comment-between-lists/delete-one-of-two-comments': {
    raw: '- a\n\n%% c %%\n\n%% d %%\n\n- b\n',
    op: deleteBlock(1),
  },
  'comment-between-lists/join-two-comments': {
    raw: '- a\n\n%% c %%\n\n%% d %%\n\n* b\n',
    op: backspaceAtStart(2),
  },
  'comment-between-lists/split-comment-paragraph': {
    raw: '+ a\n\n%% c %%\n\n* b\n',
    op: enterAtEnd(1),
    noOutline: true,
  },
  'list-in-item/insert-list-before-with-comment-separated-nested-lists': {
    raw: '- x\n\n  - a\n\n  %% c %%\n\n  * b\n',
    op: insertBefore(0, '- [ ] t'),
  },
  // a lazy line that a block written again would no longer have
  'table-in-quote+lazy-pipe-lines/insert-hr-in-quote': {
    raw: '> | x |\n> |---|\n> | 1 |\n| b |\n|---|\n| 2 |\n',
    op: insertInto(0, '---'),
  },
  'table-in-quote+lazy-pipe-lines/insert-heading-in-quote': {
    raw: '> | x |\n> |---|\n> | 1 |\n| b |\n|---|\n| 2 |\n',
    op: insertInto(0, '# H'),
  },
  'item-comment-first-line+lazy-line/type-in-other-block': {
    raw: 'x\n\n- %% c %%\ntext\n',
    op: typeBefore('x', '!'),
  },
  'ordered-item-comment-first-line+lazy-line/type-in-other-block': {
    raw: 'x\n\n1. %% c %%\ntext\n',
    op: typeBefore('x', '!'),
  },
  'quote-comment-first-line+lazy-line/type-in-other-block': {
    raw: 'x\n\n> %% c %%\ntext\n',
    op: typeBefore('x', '!'),
  },
  'paragraph-comment-first-line+indented-continuation/type-in-other-block': {
    raw: 'x\n\n%% c %%\n    code\n',
    op: typeBefore('x', '!'),
  },
  'paragraph-comment-first-line+tab-continuation/type-in-other-block': {
    raw: 'x\n\n%% c %%\n\tcode\n',
    op: typeBefore('x', '!'),
  },
  'quote-comment-first-line+indented-continuation/type-in-other-block': {
    raw: 'x\n\n> %% c %%\n>     code\n',
    op: typeBefore('x', '!'),
  },
  'item-comment-line+indented-continuation/type-in-other-block': {
    raw: 'x\n\n- a\n\n  %% c %%\n      code\n',
    op: typeBefore('x', '!'),
  },
  'list+comment-line+indented-text/type-in-other-block': {
    raw: 'x\n\n- a\n\n%% c %%\n  b\n',
    op: typeBefore('x', '!'),
  },
  // (an empty paragraph at the top level is not written, nor is a duplicated raw list a list apart: those
  // cases only compare the edit path with the forced one)
  // (an item whose first paragraph is empty is written so that it is not read back as that item: the
  // forced text is the same, so these only compare the two)
  // a block that reads differently once the block before it is gone or another one comes before it
  // (an empty marker cannot interrupt a paragraph; a list that follows a list is not a list that follows text)
  'list-item-lone-marker-text/clear-previous-paragraph': {
    raw: 'a\n- -\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'list-item-lone-marker-text/enter-at-end-of-previous-paragraph': {
    noOutline: true,
    raw: 'a\n- -\n',
    op: (doc) => tx(doc).split(2),
  },
  'list-item-lone-marker-text/clear-and-enter-previous-paragraph': {
    raw: 'a\n- -\n',
    op: clearAndEnter('a'),
    noOutline: true,
  },
  'ordered-item-lone-marker-text/clear-previous-paragraph': {
    raw: 'a\n1. -\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'ordered-item-lone-number-text/clear-previous-paragraph': {
    raw: 'a\n1. 5.\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'star-item-lone-star-text/clear-previous-paragraph': {
    raw: 'a\n* *\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'item-lone-plus-text/clear-previous-paragraph': {
    raw: 'a\n- +\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'ordered-item-lone-star-text/clear-previous-paragraph': {
    raw: 'a\n1. *\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'item-lone-number-text/clear-previous-paragraph': {
    raw: 'a\n- 1.\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'quote-lone-marker-text/clear-previous-paragraph': {
    raw: 'a\n> -\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'quote-lone-number-text/clear-previous-paragraph': {
    raw: 'a\n> 1.\n',
    op: clearText(1, 2),
    noOutline: true,
  },
  'list-item-lone-marker-text/insert-ordered-list-before-tight-list': {
    raw: 'a\n1. -\n',
    op: insertBefore(1, '1. a'),
  },
  'list-item-lone-marker-text/insert-two-item-ordered-list-before-tight-list': {
    raw: 'a\n1. -\n',
    op: insertBefore(1, '1. a\n2. b'),
  },
  'list-item-lone-marker-text/insert-paren-list-before-tight-list': {
    raw: 'a\n1. -\n',
    op: insertBefore(1, '1) a'),
  },
  'list-item-lone-number-text/insert-ordered-list-before-tight-list': {
    raw: 'a\n1. 5.\n',
    op: insertBefore(1, '1. a'),
  },
  'list-item-lone-star-text/insert-ordered-list-before-tight-list': {
    raw: 'a\n1. *\n',
    op: insertBefore(1, '1. a'),
  },
  'ordered-list-new/split-first-item-paragraph': {
    raw: 'z\n',
    op: (doc) => tx(doc).insert(0, parseBlocks('1. a\n2. b').content).split(3),
    noOutline: true,
  },
  'ordered-list-new/split-first-item-paragraph-start-2': {
    raw: 'z\n',
    op: (doc) => tx(doc).insert(0, parseBlocks('2. a\n3. b').content).split(3),
    noOutline: true,
  },
  'ordered-list-new/split-first-item-paragraph-before-quote': {
    raw: '> z\n',
    op: (doc) => tx(doc).insert(0, parseBlocks('1. a\n2. b').content).split(3),
    noOutline: true,
  },
  'list-item-unclosed-fence/delete-following-block': {
    raw: '- ```\n  u\n\n  x\n\n* ```\n  v\n',
    op: deleteBlock(1),
  },
  'list-item-unclosed-fence/delete-following-block-minimal': {
    raw: '* ```\n\n\n0.\n\n- a\n',
    op: deleteBlock(1),
  },
  'linkdef+indented-continuation/split-continuation-paragraph': {
    raw: '[a]: http://x\n    code\n',
    op: splitAfter('code'),
    noOutline: true,
  },
  'linkdef+indented-continuation/insert-block-after': {
    raw: '[a]: http://x\n    code\n',
    op: insertAtEnd('para'),
    noOutline: true,
  },
  'linkdef+tab-continuation/insert-block-after': {
    raw: '[a]: http://x\n\tcode\n',
    op: insertAtEnd('para'),
    noOutline: true,
  },
  'comment-multiblock+table+tight-hr/insert-block-at-start': {
    raw: '%% a\n\nb %%\n| a |\n|---|\n| 1 |\n---\n',
    op: insertBefore(0, 'para'),
  },
  'comment-multiblock+table+tight-hr/insert-list-at-start': {
    raw: '%% a\n\nb %%\n| a |\n|---|\n| 1 |\n---\n',
    op: insertBefore(0, '- x'),
  },
  'raw-list+table+tight-hr/duplicate-raw-list': {
    raw: '- > q\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n',
    op: (doc) => tx(doc).insert(blockAt(doc, 1), doc.child(0)),
    noOutline: true,
  },
  'raw-list-heading+table+tight-hr/duplicate-raw-list': {
    raw: '- # h\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n',
    op: (doc) => tx(doc).insert(blockAt(doc, 1), doc.child(0)),
    noOutline: true,
  },
  'footnote+tight-hr/duplicate-footnote': {
    raw: '[^1]: n\nt\n---\n',
    op: (doc) => tx(doc).insert(blockAt(doc, 1), doc.child(0)),
    noOutline: true,
  },
  'indented-code+table+tight-hr/duplicate-code': {
    raw: '    code\n| a |\n|---|\n| 1 |\n---\n',
    op: (doc) => tx(doc).insert(blockAt(doc, 1), doc.child(0)),
    noOutline: true,
  },
  // round 4 of the hunters
  // (the index of a CRLF file is read as the LF one: the closing `#` of the other heading is not a difference)
  'atx-closing-hashes-crlf/type-in-other-heading': {
    raw: '# A #\r\n\r\n# B #\r\n',
    op: typeAfterText('A', 'x'),
  },
  'atx-closing-hashes-crlf/paste-rule-at-start': {
    raw: '## A ##\r\n\r\n# B ##   \r\n',
    op: insertBefore(0, '---'),
  },
  'bom+inline-comment/paste-fence-block-at-start': {
    raw: '\uFEFFTesto %%x%%\n',
    op: (doc) => tx(doc).replace(1, 1, new Slice(parseBlocks('```\nc\n```').content, 0, 0)),
    noOutline: true,
  },
  'bom+fence-first+info-string/type-comment-in-code': {
    raw: '\uFEFF``` foo\\+bar\nfoo\n```\n',
    op: typeBefore('foo', '%%'),
  },
  'bom+comment-paragraph/paste-fence-block-at-start': {
    raw: '\uFEFFTesto\n\n%%x%%\n',
    op: insertBefore(0, '```\nc\n```'),
  },
  'linkdef-tight-heading/delete-heading-paragraph-boundary': {
    raw: '[r]: http://x\n## H\n\nN\nM\n',
    op: (doc) => tx(doc).delete(posAfter(doc, 'H'), posAfter(doc, 'N') - 1),
    noOutline: true,
  },
  'math-with-html-line/insert-heading-at-end': {
    raw: '$$\n<div>\n$$\ntext\n',
    op: insertAtEnd('# H'),
  },
  'math-with-html-line/paste-heading-at-end': {
    raw: 'text\n',
    op: (doc) => tx(doc).insert(doc.content.size, parseBlocks('# H').content),
  },
  'raw-quote-unclosed-fence+tight-task-list/type-in-previous-item': {
    raw: '- [ ] t\n> ~~~\n- [ ] t\n',
    op: typeAfterText('t', 'X'),
  },
  'raw-quote-unclosed-fence+tight-task-list/split-previous-paragraph': {
    raw: 'Set\n> ~~~\n- [ ] t\n',
    op: splitAfter('Set'),
    noOutline: true,
  },
  'raw-quote-unclosed-fence+tight-task-list/type-in-paragraph': {
    raw: 'Set\n> ~~~\n- [ ] t\n',
    op: typeAfterText('Set', 'X'),
  },
  'list-item-comment-only/delete-range-join-comment-into-item': {
    raw: 'x\n- b\n\n%% a %%\n',
    op: (doc) => tx(doc).delete(posAfter(doc, 'b') - 1, posAfter(doc, 'b') + 4),
    noOutline: true,
  },
  'list-item-comment-only/delete-range-join-comment-into-ordered-item': {
    raw: 'x\n1. b\n\n%% a %%\n',
    op: (doc) => tx(doc).delete(posAfter(doc, 'b') - 1, posAfter(doc, 'b') + 4),
    noOutline: true,
  },
  'paragraph+comment-only-item/insert-paragraph-between': {
    raw: 'y\n- %% a %%\n',
    op: insertBefore(1, 'para'),
  },
  'paragraph+comment-only-ordered-item/insert-paragraph-between': {
    raw: 'y\n1. %% a %%\n',
    op: insertBefore(1, 'para'),
  },
  'comment-indented-block/duplicate-then-insert-list-at-start': {
    raw: '  %% a %%\nb\n',
    op: (doc) => {
      const dup = tx(doc).insert(doc.child(0).nodeSize, doc.child(0)).doc;
      return tx(dup).insert(0, parseBlocks('- t').content);
    },
    noOutline: true,
  },
  'comment-indented-block-lines/duplicate-then-insert-list-at-start': {
    raw: '  %%\n  a\n  %%\n',
    op: (doc) => {
      const dup = tx(doc).insert(doc.child(0).nodeSize, doc.child(0)).doc;
      return tx(dup).insert(0, parseBlocks('- t').content);
    },
    noOutline: true,
  },
  'comment-indented-block/duplicate-then-insert-list-at-start-crlf': {
    raw: '\uFEFF  %% a %%\r\nb\r\n',
    op: (doc) => {
      const dup = tx(doc).insert(doc.child(0).nodeSize, doc.child(0)).doc;
      return tx(dup).insert(0, parseBlocks('- t').content);
    },
    noOutline: true,
  },
  'frontmatter-blank-body/type-bom-in-empty-paragraph': {
    raw: '---\na: 1\n---\n\n',
    op: (doc) => tx(doc).insertText('\uFEFF', 1),
    noOutline: true,
  },
  'frontmatter-blank-body/type-bom-in-empty-paragraph-crlf': {
    raw: '---\r\na: 1\r\n---\r\n\r\n',
    op: (doc) => tx(doc).insertText('\uFEFF', 1),
    noOutline: true,
  },
  'frontmatter-blank-body/type-bom-in-empty-paragraph-bom': {
    raw: '\uFEFF---\r\na: 1\r\n---\r\n\r\n',
    op: (doc) => tx(doc).insertText('\uFEFF', 1),
    noOutline: true,
  },
};

describe('the edit path means what the forced one means (edits found by the hunters)', () => {
  for (const [key, c] of Object.entries(CASES)) {
    it(key, () => {
      const s = open(core, c.raw);
      const doc = c.op(s.doc).doc;
      const edit = s.text(doc);
      const forced = s.text(doc, { forceDirty: true });
      const texts = JSON.stringify({ edit, forced });
      expect(tree(edit), `tree ${texts}`).toBe(tree(forced));
      expect(shape(edit), `extract ${texts}`).toBe(shape(forced));
      expect(html(edit), `html ${texts}`).toBe(html(forced));
      if (c.noOutline) return;
      // and the edit is the document: read again it gives the blocks the editor shows
      const back = open(core, edit).doc;
      expect(outline(back), 'document').toEqual(outline(doc));
    });
  }
});

/** The blocks of a document with their text, as a reader sees them (a raw block by its raw text). */
function outline(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isBlock) {
      const text = n.type.name === 'raw_block' ? String(n.attrs['raw']) : n.textContent;
      out.push(
        n.type.name + (n.isTextblock || n.type.name === 'raw_block' ? `:${text.trim()}` : ''),
      );
    }
    return true;
  });
  return out;
}

describe('what the layer keeps and what it writes again, by the way Reading closes a fence', () => {
  it('a line that starts a fence run is not kept as typed: the block gets a fence it cannot close', () => {
    const s = open(core, '```\nx\n```\n\nm\n\n%%\nc\n%%\n');
    const edit = s.text(typeBefore('x', '```')(s.doc).doc);
    expect(edit.startsWith('````\n```x\n````\n')).toBe(true);
  });

  it('a fence line with trailing text in a code block of the file is its lines, left as they are', () => {
    // no Reading preparation in the note: nothing is read differently, so the block is not raw
    const s = open(core, '```\n```x\n```\n\nm\n');
    expect(s.table.entries[0]!.node.type.name).toBe('code_block');
    expect(s.text(typeAfterText('m', 'y')(s.doc).doc)).toBe('```\n```x\n```\n\nmy\n');
  });

  it('with a comment in the note, a block whose rewrite would change what Reading prepares stays raw', () => {
    const s = open(core, '```\n```x\n```\n\nm\n\n%%\nc\n%%\n');
    expect(s.table.entries[0]!.node.type.name).toBe('raw_block');
    const doc = typeAfterText('m', 'y')(s.doc).doc;
    expect(s.text(doc)).toBe('```\n```x\n```\n\nmy\n\n%%\nc\n%%\n');
    expect(s.text(doc, { forceDirty: true })).toBe(s.text(doc));
  });

  it('a list the edit did not touch keeps its marker next to a comment, as the file has it', () => {
    const s = open(core, '- a\n\n%% c %%\n\n%% d %%\n\n- b\n');
    const edit = s.text(deleteBlock(1)(s.doc).doc);
    expect(edit).toBe('- a\n\n%% d %%\n\n- b\n');
  });
});

/** The tree, the index entry and the Reading HTML of the edit path and of the forced path are the same. */
function expectSameMeaning(s: ReturnType<typeof open>, doc: PMNode, what: string): void {
  const edit = s.text(doc);
  const forced = s.text(doc, { forceDirty: true });
  const texts = `${what} ${JSON.stringify({ edit, forced })}`;
  expect(tree(edit), `tree ${texts}`).toBe(tree(forced));
  expect(shape(edit), `extract ${texts}`).toBe(shape(forced));
  expect(html(edit), `html ${texts}`).toBe(html(forced));
}

/** Edits of a document at every text node: a character, a heading marker, Enter, a block pasted, a block deleted. */
function sweep(s: ReturnType<typeof open>, run: (doc: PMNode, what: string) => void): number {
  let n = 0;
  const doc = s.doc;
  const sites: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) sites.push(pos, pos + node.nodeSize);
    return true;
  });
  const attempt = (what: string, build: () => Transaction): void => {
    let next: PMNode;
    try {
      next = build().doc;
      next.check();
    } catch {
      return; // not an edit a user can make
    }
    if (next.eq(doc)) return;
    n++;
    run(next, what);
  };
  for (const pos of sites) {
    attempt(`type x @${pos}`, () => tx(doc).insertText('x', pos));
    attempt(`type "# " @${pos}`, () => tx(doc).insertText('# ', pos));
    attempt(`enter @${pos}`, () => tx(doc).split(pos));
  }
  for (let k = 0; k <= doc.childCount; k++) {
    attempt(`paste para @${k}`, () => tx(doc).insert(blockAt(doc, k), parseBlocks('para').content));
    if (k < doc.childCount) {
      attempt(`delete block ${k}`, () => tx(doc).delete(blockAt(doc, k), blockAt(doc, k + 1)));
    }
  }
  return n;
}

describe('blocks that touch each other are read together (the index reads a rule far down as an underline)', () => {
  const RAWS = [
    // the lazy line and the footnote definition are lines of the quote's paragraph, and the `> ---` is its underline
    '> x\ny\n[^1]: n\n> ---\n',
    '- x\n|a|b|\n[^1]: n\n---\n',
    '***\n> [!faq]- F\n[^1]: n\n> ---\n',
  ];

  it('the block whose rewrite would change what the run of blocks around it reads is kept raw', () => {
    const s = open(core, RAWS[0]!);
    expect(s.table.entries[0]!.node.type.name).toBe('raw_block');
  });

  for (const raw of RAWS) {
    it(`every edit of ${JSON.stringify(raw)} means what the forced path means`, () => {
      const s = open(core, raw);
      const n = sweep(s, (doc, what) => expectSameMeaning(s, doc, what));
      expect(n).toBeGreaterThan(3);
    });
  }
});

describe('a frontmatter inserted at the start of a note (a template, a paste)', () => {
  const FRAGMENTS = ['---\nt: 1\n---', '---\nt: 1\n---\n', '---\nt: 1\n...', '---\nt: 1\n...\n'];
  const NOTES = ['text\n', '- a\n', '> q\n', '```\nc\n```\n', 'Setext\n---\n', '1. a\n'];

  for (const fragment of FRAGMENTS) {
    for (const note of NOTES) {
      it(`${JSON.stringify(fragment)} before ${JSON.stringify(note)}: the body does not stick to the closing line`, () => {
        const s = open(core, note);
        const rest = s.adoptInserted(fragment);
        expect(rest).toBe('');
        // the view then inserts what is left: an empty paragraph
        const doc = tx(s.doc).insert(0, parseBlocks(rest).content).doc;
        const edit = s.text(doc);
        const back = open(core, edit);
        // the file reads as a note with a frontmatter (`t: 1`) and the body it had
        expect(back.envelope.frontmatter.startsWith('---\nt: 1\n')).toBe(true);
        expect(back.table.body.trim()).toBe(note.trim());
        expectSameMeaning(s, doc, 'insert');
      });
    }
  }

  it('a character typed after the frontmatter was adopted keeps it: it does not take the first line in', () => {
    const s = open(core, 'text\n');
    s.adoptInserted('---\nt: 1\n---');
    const edit = s.text(typeAfterText('t', 'X')(s.doc).doc);
    expect(edit).toBe('---\nt: 1\n---\ntXext\n');
    expect(open(core, edit).envelope.frontmatter).toBe('---\nt: 1\n---\n');
  });
});

describe('the byte order mark', () => {
  it('a first line that the edit made a fence line does not stick to the mark', () => {
    const s = open(core, '\uFEFFTesto %%x%%\n');
    const doc = tx(s.doc).replace(1, 1, new Slice(parseBlocks('```\nc\n```').content, 0, 0)).doc;
    const edit = s.text(doc);
    expect(edit.startsWith('\uFEFF```')).toBe(false);
    expect(edit.startsWith('\uFEFF\n')).toBe(true);
  });

  it('a first line the file already had is left alone', () => {
    const s = open(core, '\uFEFF```\nc\n```\n\nm\n');
    expect(s.text(typeAfterText('m', 'y')(s.doc).doc)).toBe('\uFEFF```\nc\n```\n\nmy\n');
  });

  it('a first line the file already had gets the blank line when the note has what Reading prepares', () => {
    const s = open(core, '\uFEFF```\nc\n```\n\nm\n\n%% a %%\n');
    expect(s.text(typeAfterText('m', 'y')(s.doc).doc)).toBe(
      '\uFEFF\n```\nc\n```\n\nmy\n\n%% a %%\n',
    );
  });

  it('a U+FEFF typed first in the body is text: it is not the mark of the file', () => {
    const s = open(core, 'a\n');
    const edit = s.text(typeBefore('a', '\uFEFF')(s.doc).doc);
    expect(edit).toBe('\n\uFEFFa\n');
  });
});

describe('the closing hashes of an untouched heading (the index reads a CRLF file as the LF one)', () => {
  it('stay as the file has them, with the line end of the file', () => {
    const s = open(core, '# A #\r\n\r\n# B #\r\n');
    expect(s.text(typeAfterText('A', 'x')(s.doc).doc)).toBe('# Ax\r\n\r\n# B #\r\n');
  });
});

describe('a task whose first paragraph is empty while the item holds blocks (a paste or a rule at the start of its text)', () => {
  const OPS: Record<string, string> = {
    list: '- x\n- y',
    fence: '```js\nx\n```',
    callout: '> [!note] t\n> body',
    table: '| a | b |\n| - | - |\n| 1 | 2 |',
    math: '$$\nx\n$$',
  };
  for (const [name, md] of Object.entries(OPS)) {
    it(`${name} pasted before the text: the box is not left outside the item, the lines around it are the file's`, () => {
      const raw = '# Alpha #\r\n\r\n- [ ] task\r\n- [x] b\r\n\r\n# Beta #\r\n';
      const s = open(core, raw);
      const doc = pasteBefore('task', md)(s.doc).doc;
      const edit = s.text(doc);
      expect(edit).not.toMatch(/^\[.\]/m);
      expect(edit.startsWith('# Alpha #\r\n\r\n')).toBe(true);
      expect(edit.endsWith('- [x] b\r\n\r\n# Beta #\r\n')).toBe(true);
      expectSameMeaning(s, doc, name);
      // and it is a note the editor opens again, with the task that was after it
      expect(open(core, edit).text(open(core, edit).doc)).toBe(edit);
    });
  }
});

describe('a rule `---` on the first line, and a second one inserted below it', () => {
  it('is written `***`: two `---` lines would be the frontmatter of the note, which the file did not have', () => {
    const s = open(core, '---\n\nafter a rule\n');
    expect(s.envelope.frontmatter).toBe('');
    const doc = insertAtEnd('---')(s.doc).doc;
    const edit = s.text(doc);
    expect(edit).toBe('***\n\nafter a rule\n\n---\n');
    expect(open(core, edit).envelope.frontmatter).toBe('');
    expectSameMeaning(s, doc, 'hr below an hr');
  });

  it('stays as the file has it when the rule that follows is the same kind as the one of the file', () => {
    const s = open(core, '***\n\nafter a rule\n');
    expect(s.text(insertAtEnd('---')(s.doc).doc)).toBe('***\n\nafter a rule\n\n***\n');
  });
});
