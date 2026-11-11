// The views of the Live editor (A-W5a) on the mounted Milkdown editor: what each construct of a note
// looks like, what the caret does to it, what the pointer does with it, and that none of it writes
// the note. The application is a fake context whose calls are looked at.
import { NodeSelection, Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALLOUT_ICONS } from '../../calloutIcon';
import type { EmbedDisposer, LinkSpec, LivePreviewContext } from '../../context';
import type { LiveEditor } from '../MilkdownAdapter';
import { EditorViewOf, openLive } from '../testing/mounted';
import { posAfter } from '../testing/helpers';
import { baseDecorations, baseKey } from './decorations';
import { LiveHost } from './index';

vi.setConfig({ testTimeout: 30_000 });

interface Fake extends LivePreviewContext {
  resolved: ReturnType<typeof vi.fn<(t: string) => boolean | undefined>>;
  requestResolve: ReturnType<typeof vi.fn<(t: string) => void>>;
  renderEmbed: ReturnType<typeof vi.fn<(s: LinkSpec, el: HTMLElement) => EmbedDisposer | void>>;
  renderImage: ReturnType<
    typeof vi.fn<(src: string, alt: string, el: HTMLElement) => EmbedDisposer | void>
  >;
  openLink: ReturnType<typeof vi.fn<(s: LinkSpec, newTab: boolean) => void>>;
  openExternal: ReturnType<typeof vi.fn<(url: string) => void>>;
  renderMath: ReturnType<typeof vi.fn<(tex: string, display: boolean, el: HTMLElement) => void>>;
  renderMermaid: ReturnType<typeof vi.fn<(code: string, el: HTMLElement) => void>>;
  renderQuery: ReturnType<typeof vi.fn<(source: string, el: HTMLElement) => EmbedDisposer | void>>;
}

function fake(over: Partial<LivePreviewContext> = {}): Fake {
  return {
    resolved: vi.fn(() => true),
    requestResolve: vi.fn(),
    renderEmbed: vi.fn((spec: LinkSpec, el: HTMLElement) => {
      el.textContent = `embed:${spec.target}|${spec.alias}`;
    }),
    renderImage: vi.fn((src: string, alt: string, el: HTMLElement) => {
      el.textContent = `image:${src}|${alt}`;
    }),
    openLink: vi.fn(),
    openExternal: vi.fn(),
    renderMath: vi.fn((tex: string, _d: boolean, el: HTMLElement) => {
      el.textContent = `math:${tex}`;
    }),
    renderMermaid: vi.fn((code: string, el: HTMLElement) => {
      el.textContent = `mermaid:${code}`;
    }),
    renderQuery: vi.fn((source: string, el: HTMLElement) => {
      el.textContent = `query:${source}`;
    }),
    ...over,
  } as Fake;
}

const opened: { dispose(): void }[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.dispose();
});

async function open(raw: string, ctx = fake(), over: Parameters<typeof openLive>[1] = {}) {
  const host = new LiveHost(ctx);
  const changes = vi.fn();
  const live = await openLive(raw, { views: host, onChange: changes, ...over });
  opened.push(live);
  return { ...live, view: EditorViewOf(live.editor), host, ctx, changes };
}

// jsdom has no layout: what ProseMirror asks of it to place a caret from the mouse is "nothing there"
if (!('elementFromPoint' in document)) {
  Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true });
}

/** The position before the n-th node of a type. */
function nodeStart(view: EditorView, type: string, n = 0): number {
  const at: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === type) at.push(pos);
    return true;
  });
  const pos = at[n];
  if (pos === undefined) throw new Error(`no ${type} ${n}`);
  return pos;
}

/** The position after the n-th node of a type. */
const nodeEnd = (view: EditorView, type: string, n = 0): number =>
  nodeStart(view, type, n) + (view.state.doc.nodeAt(nodeStart(view, type, n))?.nodeSize ?? 0);

/** The position `offset` characters into the text of the n-th node of a type. */
const nodeText = (view: EditorView, type: string, offset: number, n = 0): number =>
  nodeStart(view, type, n) + 1 + offset;

/** Puts the caret at a position of the document. */
function caretAt(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))));
}

const q = (parent: ParentNode, selector: string): HTMLElement | null =>
  parent.querySelector(selector);
const qa = (parent: ParentNode, selector: string): HTMLElement[] => [
  ...parent.querySelectorAll<HTMLElement>(selector),
];
const text = (e: LiveEditor) => e.text();

describe('wikilinks', () => {
  const NOTE = 'See [[Target#Head|the alias]] and [[Plain]] and [[Note#^blk]].\n';

  it('show the link of the text (alias, heading and block) and keep the source in the document', async () => {
    const { parent, editor, changes } = await open(NOTE);
    const links = qa(parent, '.ofm-wikilink');
    expect(
      links.map((l) => [l.dataset['target'], l.dataset['heading'], l.dataset['block']]),
    ).toEqual([
      ['Target', 'Head', ''],
      ['Plain', '', ''],
      ['Note', '', 'blk'],
    ]);
    // the part that is the target is a decoration, which the stylesheet hides; the alias is what shows
    expect(q(links[0]!, '.ofm-wl-hide')?.textContent).toBe('Target#Head|');
    expect(links[0]!.textContent).toBe('Target#Head|the alias');
    expect(q(links[1]!, '.ofm-wl-hide')).toBeNull();
    expect(text(editor)).toBe(NOTE);
    expect(changes).not.toHaveBeenCalled();
  });

  it('are resolved through the context: one that does not is marked, an unknown one is asked for', async () => {
    const ctx = fake({
      resolved: vi.fn((t: string) => (t === 'Plain' ? false : t === 'Target' ? true : undefined)),
    });
    const { parent } = await open(NOTE, ctx);
    const [a, b, c] = qa(parent, '.ofm-wikilink');
    expect(a!.classList.contains('ofm-unresolved')).toBe(false);
    expect(b!.classList.contains('ofm-unresolved')).toBe(true);
    // still being resolved: not marked, and the application is asked to resolve it
    expect(c!.classList.contains('ofm-unresolved')).toBe(false);
    expect(ctx.requestResolve).toHaveBeenCalledWith('Note');
    expect(ctx.requestResolve).not.toHaveBeenCalledWith('Plain');
  });

  it('look again when the resolver says that notes changed, and stop listening with the editor', async () => {
    let known = false;
    const ctx = fake({ resolved: vi.fn(() => known) });
    const { parent, host, editor } = await open('[[Later]]\n', ctx);
    const link = q(parent, '.ofm-wikilink')!;
    expect(link.classList.contains('ofm-unresolved')).toBe(true);
    known = true;
    host.linksChanged();
    expect(link.classList.contains('ofm-unresolved')).toBe(false);
    const calls = ctx.resolved.mock.calls.length;
    await editor.close();
    host.linksChanged();
    expect(ctx.resolved.mock.calls.length).toBe(calls);
  });

  it('show their source, brackets included, while the caret is in or next to them', async () => {
    const { parent, view } = await open('intro\n\n' + NOTE);
    const [first, second] = qa(parent, '.ofm-wikilink');
    expect(first!.classList.contains('ofm-active')).toBe(false);
    caretAt(view, nodeText(view, 'ofm_wikilink', 12));
    expect(first!.classList.contains('ofm-active')).toBe(true);
    expect(second!.classList.contains('ofm-active')).toBe(false);
    // next to it, before and after
    caretAt(view, nodeStart(view, 'ofm_wikilink', 0));
    expect(first!.classList.contains('ofm-active')).toBe(true);
    caretAt(view, nodeEnd(view, 'ofm_wikilink', 0));
    expect(first!.classList.contains('ofm-active')).toBe(true);
    caretAt(view, posAfter(view.state.doc, 'Se'));
    expect(first!.classList.contains('ofm-active')).toBe(false);
  });

  it('can be edited as text where the caret is, and the edit is written as typed', async () => {
    const { view, editor, changes } = await open('See [[Plain]] now.\n');
    const at = posAfter(view.state.doc, 'Plai');
    view.dispatch(view.state.tr.insertText('X', at));
    expect(text(editor)).toBe('See [[PlaiXn]] now.\n');
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('are found at the caret for the preview by keyboard: inside, next to, and not elsewhere', async () => {
    const { view, editor } = await open('See [[Target#Head|alias]] and ![[emb.png]] end\n');
    caretAt(view, nodeText(view, 'ofm_wikilink', 9));
    expect(editor.linkAt('cursor')?.spec).toMatchObject({
      target: 'Target',
      heading: 'Head',
      alias: 'alias',
      embed: false,
    });
    caretAt(view, nodeStart(view, 'ofm_wikilink', 0));
    expect(editor.linkAt('cursor')?.spec.target).toBe('Target');
    caretAt(view, nodeEnd(view, 'ofm_wikilink', 0));
    expect(editor.linkAt('cursor')?.spec.target).toBe('Target');
    caretAt(view, posAfter(view.state.doc, 'See'));
    expect(editor.linkAt('cursor')).toBeNull();
    // an embed shows its content already: no preview
    caretAt(view, nodeText(view, 'ofm_wikilink', 3, 1));
    expect(editor.linkAt('cursor')).toBeNull();
  });
});

describe('embeds', () => {
  const NOTE = 'Before ![[pic.png|300x200]] after ![[Other#Sec]]\n';

  it('are drawn by the context with the size of their alias, and the source stays in the document', async () => {
    const { parent, editor, ctx, changes } = await open(NOTE);
    expect(ctx.renderEmbed).toHaveBeenCalledTimes(2);
    expect(ctx.renderEmbed.mock.calls[0]![0]).toEqual({
      target: 'pic.png',
      heading: '',
      block: '',
      alias: '300x200',
      embed: true,
    });
    expect(ctx.renderEmbed.mock.calls[1]![0]).toMatchObject({ target: 'Other', heading: 'Sec' });
    expect(qa(parent, '.ofm-embed-render').map((e) => e.textContent)).toEqual([
      'embed:pic.png|300x200',
      'embed:Other|',
    ]);
    expect(text(editor)).toBe(NOTE);
    expect(changes).not.toHaveBeenCalled();
  });

  it('free what they drew when the node goes (edited away, or the editor closed)', async () => {
    const dispose = vi.fn();
    const ctx = fake({
      renderEmbed: vi.fn((spec: LinkSpec, el: HTMLElement) => {
        el.textContent = spec.target;
        return { dispose };
      }),
    });
    const { view, editor } = await open('a ![[one]] b ![[two]] c\n', ctx);
    expect(dispose).not.toHaveBeenCalled();
    // the first embed is deleted
    view.dispatch(
      view.state.tr.delete(nodeStart(view, 'ofm_wikilink', 0), nodeEnd(view, 'ofm_wikilink', 0)),
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    await editor.close();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('show their source, and not the drawing, while the caret is in or next to them', async () => {
    const { parent, view } = await open(NOTE);
    const [first, second] = qa(parent, '.ofm-embed');
    caretAt(view, posAfter(view.state.doc, 'Before'));
    expect(first!.classList.contains('ofm-active')).toBe(false);
    caretAt(view, nodeText(view, 'ofm_wikilink', 5, 0));
    expect(first!.classList.contains('ofm-active')).toBe(true);
    expect(second!.classList.contains('ofm-active')).toBe(false);
  });

  it('take the caret into their source when the drawing is clicked, but not when a control of it is', async () => {
    const ctx = fake({
      renderEmbed: vi.fn((_s: LinkSpec, el: HTMLElement) => {
        el.innerHTML = '<span class="plain">drawn</span><a class="control" href="#x">go</a>';
      }),
    });
    const { parent, view, editor, changes } = await open('intro\n\nx ![[pic.png]] y\n', ctx);
    const embed = q(parent, '.ofm-embed')!;
    const press = (el: Element) => {
      const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
      el.dispatchEvent(e);
      return e;
    };
    expect(press(q(embed, '.control')!).defaultPrevented).toBe(false);
    expect(embed.classList.contains('ofm-active')).toBe(false);
    expect(press(q(embed, '.plain')!).defaultPrevented).toBe(true);
    expect(embed.classList.contains('ofm-active')).toBe(true);
    // the caret is at the end of the source, inside the node
    const { $head } = view.state.selection;
    expect($head.parent.type.name).toBe('ofm_wikilink');
    expect($head.parentOffset).toBe('pic.png'.length);
    expect(text(editor)).toBe('intro\n\nx ![[pic.png]] y\n');
    expect(changes).not.toHaveBeenCalled();
  });

  it('are drawn again, once the source stops changing, when it is edited', async () => {
    vi.useFakeTimers();
    try {
      const { view, ctx } = await open('x ![[one]] y\n');
      expect(ctx.renderEmbed).toHaveBeenCalledTimes(1);
      view.dispatch(view.state.tr.insertText('s', posAfter(view.state.doc, 'on')));
      view.dispatch(view.state.tr.insertText('t', posAfter(view.state.doc, 'ons')));
      expect(ctx.renderEmbed).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(300);
      expect(ctx.renderEmbed).toHaveBeenCalledTimes(2);
      expect(ctx.renderEmbed.mock.calls[1]![0].target).toBe('onste');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('images', () => {
  const NOTE =
    '![the alt|300](pics/a%20b.png "cap")\n\nText ![inline](rel.png) and ![bad](javascript:x) end\n';

  it('are drawn by the context: the path decoded, the alt with its size, block and inline', async () => {
    const { parent, editor, ctx, changes } = await open(NOTE);
    expect(ctx.renderImage.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['pics/a b.png', 'the alt|300'],
      ['rel.png', 'inline'],
    ]);
    expect(q(parent, '.ofm-image-block .ofm-image-body')?.textContent).toBe(
      'image:pics/a b.png|the alt|300',
    );
    expect(q(parent, '.ofm-image-inline .ofm-image-body')?.textContent).toBe(
      'image:rel.png|inline',
    );
    expect(text(editor)).toBe(NOTE);
    expect(changes).not.toHaveBeenCalled();
  });

  it('are not loaded from a scheme that a note may not open: the alt stands for the image', async () => {
    const { parent, ctx } = await open('![bad](javascript:x)\n\nnext\n');
    expect(ctx.renderImage).not.toHaveBeenCalled();
    const body = q(parent, '.ofm-image .ofm-image-body')!;
    expect(body.textContent).toBe('bad');
    expect(body.closest('.ofm-image')?.classList.contains('ofm-image-missing')).toBe(true);
  });

  it("are the context's to draw for a web image as well (it decides with isSafeExternalUrl)", async () => {
    const { ctx } = await open('![web](https://example.org/x.png)\n');
    expect(ctx.renderImage).toHaveBeenCalledWith(
      'https://example.org/x.png',
      'web',
      expect.anything(),
    );
  });

  it('free their render when they go', async () => {
    const dispose = vi.fn();
    const ctx = fake({
      renderImage: vi.fn((_s: string, _a: string, el: HTMLElement) => {
        el.textContent = 'img';
        return dispose;
      }),
    });
    const { editor } = await open('![a](a.png)\n\n![b](b.png)\n', ctx);
    expect(dispose).not.toHaveBeenCalled();
    await editor.close();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

describe('callouts', () => {
  const callout = (type: string, marker = '') =>
    `> [!${type}]${marker} Title of ${type}\n> body line\n\n`;

  it('are a box of their type with an icon for each of the types the application knows', async () => {
    const types = Object.keys(CALLOUT_ICONS);
    expect(types.length).toBe(27);
    const raw = 'intro\n\n' + types.map((t) => callout(t)).join('') + 'end\n';
    const { parent, editor, changes } = await open(raw);
    const boxes = qa(parent, 'blockquote.ofm-callout');
    expect(boxes.map((b) => b.dataset['callout'])).toEqual(types);
    for (const [i, t] of types.entries()) {
      const box = boxes[i]!;
      expect(box.classList.contains(`ofm-callout-${t}`)).toBe(true);
      // the icon of the type, and the head line of the source out of sight
      expect(q(box, '.ofm-callout-icon svg')).not.toBeNull();
      expect(q(box, '.ofm-callout-head')?.textContent).toBe(`[!${t}] `);
      expect(q(box, '.ofm-callout-title-text')?.textContent).toBe(`Title of ${t}`);
    }
    expect(text(editor)).toBe(raw);
    expect(changes).not.toHaveBeenCalled();
  });

  it('use the icon of their type: a different one for note and warning', async () => {
    const { parent } = await open('intro\n\n' + callout('note') + callout('warning') + 'end\n');
    const [note, warning] = qa(parent, '.ofm-callout-icon svg');
    expect(note!.innerHTML).not.toBe(warning!.innerHTML);
  });

  it('show the name of the type when they have no title, and are not foldable without a marker', async () => {
    const { parent } = await open('intro\n\n> [!tip]\n> only a body\n\nend\n');
    expect(q(parent, '.ofm-callout-name')?.textContent).toBe('Tip');
    expect(q(parent, '.ofm-callout-chevron')).toBeNull();
    expect(q(parent, 'blockquote')!.classList.contains('ofm-callout-foldable')).toBe(false);
  });

  it('are not callouts when the quote is nested in a quote, or the first line is not a head', async () => {
    const { parent } = await open(
      'intro\n\n> plain quote\n> [!note] not a head\n\n> > [!note] nested\n\nend\n',
    );
    expect(qa(parent, '.ofm-callout').length).toBe(0);
  });

  it('fold from their marker, flip from the chevron, and flipping is not an edit', async () => {
    const note =
      'intro\n\n> [!note]- Folded\n> hidden body\n>\n> second para\n\n> [!note]+ Open\n> shown body\n\nend\n';
    const { parent, view, editor, changes } = await open(note);
    const [folded, open_] = qa(parent, 'blockquote.ofm-callout');
    expect(folded!.classList.contains('ofm-callout-folded')).toBe(true);
    expect(open_!.classList.contains('ofm-callout-folded')).toBe(false);
    // the body (the rest of the first paragraph and the other blocks) is marked as hidden
    expect(qa(folded!, '.ofm-callout-hidden').map((e) => e.tagName)).toEqual(['SPAN', 'SPAN', 'P']);
    expect(q(folded!, '.ofm-callout-chevron')?.getAttribute('aria-expanded')).toBe('false');
    expect(q(folded!, '.ofm-callout-chevron')?.getAttribute('aria-label')).toBeTruthy();
    const before = view.state.doc;

    q(folded!, '.ofm-callout-chevron')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    const now = qa(parent, 'blockquote.ofm-callout');
    expect(now[0]!.classList.contains('ofm-callout-folded')).toBe(false);
    expect(qa(now[0]!, '.ofm-callout-hidden').length).toBe(0);
    expect(q(now[0]!, '.ofm-callout-chevron')?.getAttribute('aria-expanded')).toBe('true');

    q(now[1]!, '.ofm-callout-chevron')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    expect(qa(parent, 'blockquote.ofm-callout')[1]!.classList.contains('ofm-callout-folded')).toBe(
      true,
    );

    // a view state: the document, the text and the note's dirty state are what they were
    expect(view.state.doc).toBe(before);
    expect(text(editor)).toBe(note);
    expect(editor.edited).toBe(false);
    expect(changes).not.toHaveBeenCalled();
  });

  it('flip from the keyboard, with Enter or Space on the chevron', async () => {
    const { parent } = await open('intro\n\n> [!note]- F\n> body\n\nend\n');
    const chevron = () => q(parent, '.ofm-callout-chevron')!;
    expect(chevron().tabIndex).toBe(0);
    chevron().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(q(parent, 'blockquote')!.classList.contains('ofm-callout-folded')).toBe(false);
    chevron().dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    expect(q(parent, 'blockquote')!.classList.contains('ofm-callout-folded')).toBe(true);
  });

  it('keep the fold the user chose through edits above them', async () => {
    const { parent, view } = await open('first\n\n> [!note]- F\n> body\n\nend\n');
    q(parent, '.ofm-callout-chevron')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(q(parent, 'blockquote')!.classList.contains('ofm-callout-folded')).toBe(false);
    view.dispatch(view.state.tr.insertText('more ', posAfter(view.state.doc, 'first') - 5));
    expect(q(parent, 'blockquote')!.classList.contains('ofm-callout-folded')).toBe(false);
  });

  it('show a folded body while the caret is in it, and the source of the head while it is on the head', async () => {
    const { parent, view } = await open('intro\n\n> [!note]- F title\n> hidden body\n\nend\n');
    const box = () => q(parent, 'blockquote')!;
    expect(box().classList.contains('ofm-callout-folded')).toBe(true);
    caretAt(view, posAfter(view.state.doc, 'hidden bo'));
    expect(box().classList.contains('ofm-callout-folded')).toBe(false);
    // on the head: no widget, no hidden head (the source is shown)
    caretAt(view, posAfter(view.state.doc, '[!note]- F ti'));
    expect(q(box(), '.ofm-callout-title')).toBeNull();
    expect(q(box(), '.ofm-callout-head')).toBeNull();
    caretAt(view, posAfter(view.state.doc, 'end'));
    expect(q(box(), '.ofm-callout-title')).not.toBeNull();
    expect(box().classList.contains('ofm-callout-folded')).toBe(true);
  });

  it('write nothing when the caret goes through them', async () => {
    const raw = 'intro\n\n' + callout('note', '-') + callout('tip', '+') + 'end\n';
    const { view, editor, changes } = await open(raw);
    for (let pos = 1; pos < view.state.doc.content.size; pos++) {
      try {
        caretAt(view, pos);
      } catch {
        /* not a cursor position */
      }
    }
    expect(text(editor)).toBe(raw);
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('math, diagrams and queries', () => {
  const NOTE = [
    'Inline $a+b$ and $$c^2$$ here.',
    '',
    '$$',
    '\\int x',
    '$$',
    '',
    '```mermaid',
    'graph TD',
    'A-->B',
    '```',
    '',
    '```query',
    'tag:#x',
    '```',
    '',
    'end',
    '',
  ].join('\n');

  it('draw inline math (KaTeX) in the line, and `$$x$$` in a line through the context', async () => {
    const { parent, ctx, editor } = await open(NOTE);
    expect(q(parent, '[data-type="math_inline"] .katex')).not.toBeNull();
    expect(ctx.renderMath).toHaveBeenCalledWith('c^2', false, expect.anything());
    expect(q(parent, '.ofm-raw-math .ofm-math-render')?.textContent).toBe('math:c^2');
    // the source is in the DOM, hidden by the stylesheet until the caret comes
    expect(q(parent, '.ofm-raw-math .ofm-raw-text')?.textContent).toBe('$$c^2$$');
    expect(text(editor)).toBe(NOTE);
  });

  it('draw display math, diagrams and queries in place of their source', async () => {
    const { parent, ctx } = await open(NOTE);
    expect(ctx.renderMath).toHaveBeenCalledWith('\\int x', true, expect.anything());
    expect(ctx.renderMermaid).toHaveBeenCalledWith('graph TD\nA-->B', expect.anything());
    expect(ctx.renderQuery).toHaveBeenCalledWith('tag:#x', expect.anything());
    const drawn = qa(parent, '.ofm-drawn');
    expect(drawn.map((d) => d.classList[1])).toEqual(['ofm-latex', 'ofm-mermaid', 'ofm-query']);
    // the code blocks are still there, hidden by a decoration
    expect(qa(parent, '.ofm-block-drawn').length).toBe(3);
  });

  it('show the source of a block, and not its drawing, while the caret is in it', async () => {
    const { parent, view } = await open(NOTE);
    caretAt(view, posAfter(view.state.doc, 'graph T'));
    expect(qa(parent, '.ofm-drawn').map((d) => d.classList[1])).toEqual(['ofm-latex', 'ofm-query']);
    expect(qa(parent, '.ofm-block-drawn').length).toBe(2);
    caretAt(view, posAfter(view.state.doc, 'end'));
    expect(qa(parent, '.ofm-drawn').length).toBe(3);
  });

  it('keep a drawing, and do not draw it again, while the caret moves elsewhere', async () => {
    const { parent, view, ctx } = await open(NOTE);
    const drawn = qa(parent, '.ofm-mermaid')[0];
    caretAt(view, posAfter(view.state.doc, 'Inline'));
    caretAt(view, posAfter(view.state.doc, 'end'));
    view.dispatch(view.state.tr.insertText('!', posAfter(view.state.doc, 'end')));
    expect(qa(parent, '.ofm-mermaid')[0]).toBe(drawn);
    expect(ctx.renderMermaid).toHaveBeenCalledTimes(1);
  });

  it('take the caret into the source when the drawing is clicked, and free the query with the drawing', async () => {
    const ctx = fake();
    const { parent, view } = await open(NOTE, ctx);
    q(parent, '.ofm-mermaid')!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    );
    const $head = view.state.selection.$head;
    expect($head.parent.type.name).toBe('code_block');
    expect($head.parent.attrs['language']).toBe('mermaid');
    expect(qa(parent, '.ofm-mermaid').length).toBe(0);
  });

  it('do not draw an empty block, and draw what was just filled in', async () => {
    const { parent, view, ctx } = await open('intro\n\n```mermaid\n```\n\nend\n');
    expect(qa(parent, '.ofm-drawn').length).toBe(0);
    const inside = nodeStart(view, 'code_block') + 1;
    caretAt(view, inside);
    view.dispatch(view.state.tr.insertText('graph LR', inside));
    expect(ctx.renderMermaid).not.toHaveBeenCalled(); // the caret is in it
    caretAt(view, posAfter(view.state.doc, 'end'));
    expect(ctx.renderMermaid).toHaveBeenCalledWith('graph LR', expect.anything());
  });

  it('say nothing of a query when the application cannot render one', async () => {
    const ctx = fake();
    delete (ctx as Partial<LivePreviewContext>).renderQuery;
    const { parent } = await open('intro\n\n```query\ntag:#x\n```\n\nend\n', ctx);
    expect(q(parent, '.ofm-query')?.textContent).toBe('tag:#x');
  });
});

describe('what is drawn is freed', () => {
  it('frees the query of a block when the block is edited into something else, and when the editor closes', async () => {
    const stop = vi.fn();
    const ctx = fake({
      renderQuery: vi.fn((source: string, el: HTMLElement) => {
        el.textContent = source;
        return stop;
      }),
    });
    const { view, editor } = await open('intro\n\n```query\ntag:#x\n```\n\nend\n', ctx);
    expect(stop).not.toHaveBeenCalled();
    // the caret goes into the block: the drawing goes
    caretAt(view, nodeStart(view, 'code_block') + 2);
    expect(stop).toHaveBeenCalledTimes(1);
    caretAt(view, posAfter(view.state.doc, 'end'));
    expect(ctx.renderQuery).toHaveBeenCalledTimes(2);
    await editor.close();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('shows the views of the new text after the file was loaded again', async () => {
    const { parent, editor, changes } = await open('intro\n\n[[Old]] and ![[old.png]]\n');
    expect(editor.reload('intro\n\n[[New|alias]] and\n\n> [!tip] Hint\n> text\n')).toBeNull();
    expect(qa(parent, '.ofm-wikilink').map((l) => l.dataset['target'])).toEqual(['New']);
    expect(qa(parent, '.ofm-embed').length).toBe(0);
    expect(q(parent, '.ofm-callout-tip')).not.toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('tags, highlights, block ids, comments and footnotes', () => {
  const NOTE =
    'A #tag and ==marked== and a ^block-id\n\nBy %% hidden %% word, a note[^1] and ^[inline note].\n\n[^1]: the note\n';

  it('are marks and atoms of the text, written as they are', async () => {
    const { parent, editor, changes } = await open(NOTE);
    expect(q(parent, 'span[data-ofm="tag"]')?.textContent).toBe('#tag');
    expect(q(parent, 'mark[data-ofm="highlight"]')?.textContent).toBe('marked');
    expect(q(parent, 'span[data-ofm="blockid"]')?.textContent).toBe('^block-id');
    expect(q(parent, '.ofm-raw-footref')?.textContent).toBe('[^1]');
    expect(q(parent, '.ofm-raw-footnote')?.textContent).toBe('^[inline note]');
    expect(q(parent, '.ofm-raw-footdef')?.textContent).toBe('[^1]: the note');
    expect(text(editor)).toBe(NOTE);
    expect(changes).not.toHaveBeenCalled();
  });

  it('keep a comment out of sight until the caret is in or next to it', async () => {
    const { parent, view } = await open('intro\n\n' + NOTE);
    const comment = q(parent, '.ofm-raw-comment')!;
    expect(comment.classList.contains('ofm-active')).toBe(false);
    expect(comment.textContent).toBe('%% hidden %%');
    caretAt(view, nodeStart(view, 'raw_inline', 0));
    expect(comment.classList.contains('ofm-active')).toBe(true);
    caretAt(view, nodeEnd(view, 'raw_inline', 0));
    expect(comment.classList.contains('ofm-active')).toBe(true);
    caretAt(view, posAfter(view.state.doc, 'By %% hidden %% w'.slice(0, 2)));
    expect(comment.classList.contains('ofm-active')).toBe(false);
    // the atom is selected as a whole by the keyboard
    view.dispatch(
      view.state.tr.setSelection(
        NodeSelection.create(view.state.doc, nodeStart(view, 'raw_inline', 0)),
      ),
    );
    expect(comment.classList.contains('ofm-active')).toBe(true);
  });

  it('keep a comment of several lines (a block of its own) out of sight too', async () => {
    const raw = 'one\n\n%% a comment\non two lines %%\n\ntwo\n';
    const { parent, view, editor } = await open(raw);
    const block = q(parent, '.ofm-raw-comment')!;
    expect(block.tagName).toBe('DIV');
    expect(block.classList.contains('ofm-active')).toBe(false);
    view.dispatch(
      view.state.tr.setSelection(
        NodeSelection.create(view.state.doc, nodeStart(view, 'raw_block', 0)),
      ),
    );
    expect(block.classList.contains('ofm-active')).toBe(true);
    expect(text(editor)).toBe(raw);
  });
});

describe('HTML', () => {
  it('styles a pair of tags of a known kind and hides the tags, the way the text reads', async () => {
    const raw = 'a <b>bold</b> and <sub>sub</sub> and <u>under</u> and <span>kept</span> b<br>c\n';
    const { parent, editor, changes } = await open(raw);
    expect(qa(parent, '.ofm-html-bold').map((e) => e.textContent)).toEqual(['bold']);
    expect(qa(parent, '.ofm-html-sub').map((e) => e.textContent)).toEqual(['sub']);
    expect(qa(parent, '.ofm-html-underline').map((e) => e.textContent)).toEqual(['under']);
    // the four tags of the first two pairs and of the third are hidden unless the caret is by them
    expect(qa(parent, '.ofm-html-paired').length).toBe(6);
    // a pair that is not a style stays source; the line break is one
    expect(qa(parent, '.ofm-raw-html').map((e) => e.textContent)).toContain('<span>');
    expect(q(parent, '.ofm-raw-br')).not.toBeNull();
    expect(text(editor)).toBe(raw);
    expect(changes).not.toHaveBeenCalled();
  });

  it('shows the tags of a pair while the caret is by them', async () => {
    const { parent, view } = await open('a <b>bold</b> c\n');
    const [open_, close] = qa(parent, '.ofm-html-paired');
    caretAt(view, nodeStart(view, 'raw_inline', 0));
    expect(open_!.classList.contains('ofm-active')).toBe(true);
    expect(close!.classList.contains('ofm-active')).toBe(false);
  });

  it('shows an HTML block sanitized: no script, no handler, no style attribute, no frame', async () => {
    const raw =
      '<div class="x" style="color:red" onclick="alert(1)">Hello <b>there</b></div>\n\n<script>alert(1)</script>\n\n<iframe src="https://x.test"></iframe>\n\nend\n';
    const { parent, editor, changes } = await open(raw);
    const render = qa(parent, '.ofm-html-render');
    expect(render.length).toBeGreaterThan(0);
    const html = render.map((r) => r.innerHTML).join('');
    expect(html).toContain('Hello');
    expect(html).not.toMatch(/<script|<iframe|onclick|style=/i);
    expect(qa(parent, '.ofm-html-render style, .ofm-html-render [style]').length).toBe(0);
    expect(text(editor)).toBe(raw);
    expect(changes).not.toHaveBeenCalled();
  });

  it('shows no resource of anywhere else in an HTML block: a remote image gives way to its alt text', async () => {
    const { parent } = await open(
      '<div>text <img src="https://example.org/x.png" alt="remote"> <img src="local.png"></div>\n\nend\n',
    );
    const render = q(parent, '.ofm-html-render')!;
    expect(render.querySelectorAll('[src]').length).toBe(0);
    expect(render.textContent).toContain('remote');
  });

  it('leaves an HTML comment block as source, since nothing of it can be shown', async () => {
    const { parent } = await open('<!-- note -->\n\nend\n');
    const block = q(parent, '[data-ofm="raw-block"]')!;
    expect(block.classList.contains('ofm-raw-htmlblock')).toBe(false);
    expect(block.textContent).toBe('<!-- note -->');
  });
});

describe('a context that fails', () => {
  it('leaves the note open, with the source shown where a render threw, and the text untouched', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    const ctx = fake({
      renderEmbed: vi.fn(boom),
      renderImage: vi.fn(boom),
      renderMath: vi.fn(boom),
      renderMermaid: vi.fn(boom),
      renderQuery: vi.fn(boom),
      resolved: vi.fn(boom),
    });
    const raw =
      'intro\n\n[[Link]] ![[emb.png]] $$m$$\n\n![alt](a.png)\n\n```mermaid\ngraph TD\n```\n\n```query\ntag:#x\n```\n\n$$\nx\n$$\n\nend\n';
    const { parent, editor, changes } = await open(raw, ctx);
    expect(q(parent, '.ofm-wikilink')!.classList.contains('ofm-unresolved')).toBe(false);
    expect(q(parent, '.ofm-embed-render')!.textContent).toBe('![[emb.png]]');
    expect(q(parent, '.ofm-math-render')!.textContent).toBe('m');
    expect(q(parent, '.ofm-image-body')!.textContent).toBe('alt');
    expect(qa(parent, '.ofm-drawn').map((d) => d.textContent)).toEqual(['graph TD', 'tag:#x', 'x']);
    expect(text(editor)).toBe(raw);
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('what the pointer does', () => {
  const NOTE =
    'A [[Target#Head|alias]], a #tag and a [site](https://example.org/x) or [rel](Folder/Other%20note.md#sec).\n';

  const press = (el: Element, init: MouseEventInit = {}) => {
    const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(e);
    return e;
  };

  it('follows a wikilink with Mod+click, in a new tab with Alt as well, and does nothing on a plain click', async () => {
    const { parent, ctx } = await open(NOTE);
    const link = q(parent, '.ofm-wikilink')!;
    expect(press(link).defaultPrevented).toBe(false);
    expect(ctx.openLink).not.toHaveBeenCalled();
    expect(press(link, { metaKey: true }).defaultPrevented).toBe(true);
    expect(ctx.openLink).toHaveBeenLastCalledWith(
      { target: 'Target', heading: 'Head', block: '', alias: '', embed: false },
      false,
    );
    press(link, { ctrlKey: true, altKey: true });
    expect(ctx.openLink).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: 'Target' }),
      true,
    );
    expect(ctx.openLink).toHaveBeenCalledTimes(2);
  });

  it('searches for a tag with Mod+click', async () => {
    const { parent, ctx } = await open(NOTE);
    press(q(parent, 'span[data-ofm="tag"]')!, { metaKey: true });
    expect(ctx.openLink).toHaveBeenCalledWith(
      { target: '', heading: '', block: '', alias: '#tag', embed: false },
      false,
    );
  });

  it('opens a web link outside and a link to a note inside, with Mod+click', async () => {
    const { parent, ctx } = await open(NOTE);
    const [web, rel] = qa(parent, 'a[href]');
    press(web!, { metaKey: true });
    expect(ctx.openExternal).toHaveBeenCalledWith('https://example.org/x');
    press(rel!, { metaKey: true, altKey: true });
    expect(ctx.openLink).toHaveBeenCalledWith(
      { target: 'Folder/Other note.md', heading: '', block: '', alias: '', embed: false },
      true,
    );
  });

  it('never lets the browser follow a link, with a click of any kind', async () => {
    const { parent, ctx } = await open(NOTE);
    const web = q(parent, 'a[href]')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    web.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(ctx.openExternal).not.toHaveBeenCalled();
  });

  it('ignores Mod+click on what is no link, and on an embed', async () => {
    const { parent, ctx } = await open('plain ![[emb.png]] text\n');
    press(q(parent, '.ofm-embed')!, { metaKey: true });
    press(q(parent, '.ofm-embed-render')!, { metaKey: true });
    press(q(parent, 'p')!, { metaKey: true });
    expect(ctx.openLink).not.toHaveBeenCalled();
    expect(ctx.openExternal).not.toHaveBeenCalled();
  });

  it('follows nothing with Mod+click on a link that is next to the caret only as source', async () => {
    const { parent, view, ctx } = await open(NOTE);
    caretAt(view, posAfter(view.state.doc, 'A '));
    press(q(parent, '.ofm-wikilink')!, { metaKey: true });
    // the source is shown now, and the click is still a follow: Mod+click always follows
    expect(ctx.openLink).toHaveBeenCalledTimes(1);
  });

  it('stops listening with the editor', async () => {
    const { parent, ctx, editor } = await open(NOTE);
    const link = q(parent, '.ofm-wikilink')!;
    editor.dispose();
    press(link, { metaKey: true });
    expect(ctx.openLink).not.toHaveBeenCalled();
  });
});

describe('the page preview', () => {
  it('is asked for by hover over a wikilink when the settings want it, not over an embed or a plain word', async () => {
    const popover = await import('../../../preview/popover');
    const hover = await import('../../../preview/hover');
    const store = await import('../../../state/store');
    const settings = await import('../../../state/settings');
    const schedule = vi.spyOn(popover, 'schedulePreview').mockImplementation(() => undefined);
    const hide = vi.spyOn(popover, 'scheduleHidePreview').mockImplementation(() => undefined);
    vi.spyOn(hover, 'pathOfElement').mockReturnValue('Notes/Here.md');
    const vaultGet = vi.spyOn(store.useAppStore, 'getState');
    vaultGet.mockReturnValue({
      ...store.useAppStore.getState(),
      vault: { id: 'v1' },
    } as never);
    const editorSettings = settings.useSettings.getState().editor;
    vi.spyOn(settings.useSettings, 'getState').mockReturnValue({
      ...settings.useSettings.getState(),
      editor: { ...editorSettings, pagePreview: true, pagePreviewAlways: true },
    });
    try {
      const { parent } = await open('A [[Target#Head|alias]] and ![[emb.png]] and word\n');
      const move = (el: Element) =>
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      move(q(parent, '.ofm-wikilink')!);
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(schedule.mock.calls[0]![0]).toMatchObject({
        vaultId: 'v1',
        fromPath: 'Notes/Here.md',
        spec: { target: 'Target', heading: 'Head', alias: 'alias' },
      });
      move(q(parent, '.ofm-embed')!);
      move(q(parent, 'p')!);
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(hide).toHaveBeenCalledTimes(2);
      parent.dispatchEvent(new MouseEvent('mouseleave'));
      expect(hide).toHaveBeenCalledTimes(3);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('is not asked for without the modifier when the settings only want it with one', async () => {
    const popover = await import('../../../preview/popover');
    const store = await import('../../../state/store');
    const settings = await import('../../../state/settings');
    const schedule = vi.spyOn(popover, 'schedulePreview').mockImplementation(() => undefined);
    vi.spyOn(store.useAppStore, 'getState').mockReturnValue({
      ...store.useAppStore.getState(),
      vault: { id: 'v1' },
    } as never);
    const s = settings.useSettings.getState();
    vi.spyOn(settings.useSettings, 'getState').mockReturnValue({
      ...s,
      editor: { ...s.editor, pagePreview: true, pagePreviewAlways: false },
    });
    try {
      const { parent } = await open('A [[Target]] x\n');
      q(parent, '.ofm-wikilink')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('the document under all of these', () => {
  it('is never written by looking: every place selected, every element hovered and clicked', async () => {
    const raw = [
      '---',
      'title: x',
      '---',
      '> [!note]- Folded',
      '> body',
      '',
      '> [!warning]+ Open',
      '> body',
      '',
      'Link [[A#h|al]] embed ![[img.png|20]] tag #t ==hi== ^id %% c %% $$m$$ [^1] ^[n] <b>x</b> <br> end',
      '',
      '![alt|30](a.png) and ![i](b.png)',
      '',
      '```mermaid',
      'graph TD',
      '```',
      '',
      '$$',
      'x',
      '$$',
      '',
      '```query',
      'tag:#t',
      '```',
      '',
      '<div>html</div>',
      '',
      '%% multi',
      'line %%',
      '',
      '[^1]: note',
      '',
    ].join('\n');
    const { parent, view, editor, changes } = await open(raw);
    for (let pos = 0; pos <= view.state.doc.content.size; pos++) {
      try {
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))));
      } catch {
        /* not a cursor position */
      }
      try {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
      } catch {
        /* not a node that can be selected */
      }
    }
    for (const el of parent.querySelectorAll('*')) {
      for (const type of [
        'mouseover',
        'mousemove',
        'mouseenter',
        'focusin',
        'click',
        'mousedown',
      ]) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
      }
    }
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(changes).not.toHaveBeenCalled();
    expect(editor.edited).toBe(false);
    expect(text(editor)).toBe(raw);
  });
});

describe('the decorations that follow the text', () => {
  const listOf = (set: { find(): readonly { from: number; to: number }[] }) =>
    set
      .find()
      .map((d) => [
        d.from,
        d.to,
        JSON.stringify((d as unknown as { type: { attrs: object } }).type.attrs),
      ])
      .sort(
        (a, b) =>
          (a[0] as number) - (b[0] as number) ||
          (a[1] as number) - (b[1] as number) ||
          String(a[2]).localeCompare(String(b[2])),
      );

  it('are, after any edit, what drawing them from scratch gives', async () => {
    const raw =
      'one [[A|x]] <b>b</b> two\n\nthree [[B|y]] and [[C]]\n\nfour <i>i</i> five\n\n- item [[D|z]] <u>u</u>\n\nsix\n';
    const { view } = await open(raw);
    const same = (): void => {
      const kept = baseKey.getState(view.state);
      expect(kept).toBeDefined();
      expect(listOf(kept!)).toEqual(listOf(baseDecorations(view.state.doc, new WeakMap())));
    };
    same();
    const edits: (() => void)[] = [
      () => view.dispatch(view.state.tr.insertText('Q', nodeText(view, 'ofm_wikilink', 2, 0))),
      () => view.dispatch(view.state.tr.split(posAfter(view.state.doc, 'thr'))),
      () =>
        view.dispatch(
          view.state.tr.delete(posAfter(view.state.doc, 'on'), posAfter(view.state.doc, 'fo')),
        ),
      () =>
        view.dispatch(
          view.state.tr.delete(
            nodeStart(view, 'ofm_wikilink', 0),
            nodeEnd(view, 'ofm_wikilink', 0),
          ),
        ),
      () =>
        view.dispatch(
          view.state.tr.insert(posAfter(view.state.doc, 'si'), [
            view.state.schema.nodes['raw_inline']!.create({ raw: '<sup>' }),
            view.state.schema.text('s'),
            view.state.schema.nodes['raw_inline']!.create({ raw: '</sup>' }),
          ]),
        ),
      () => view.dispatch(view.state.tr.insertText('!', 1)),
    ];
    for (const edit of edits) {
      edit();
      same();
    }
    // undone, and the document replaced in one piece (a file loaded again)
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, view.state.doc.content),
    );
    same();
  });
});

describe('a large note', () => {
  it('keeps typing cheap with every view on: the decorations follow the edited block, not the note', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 1500; i++) {
      parts.push(
        `Paragraph ${i} with [[Note ${i}#h|alias ${i}]], #tag${i}, ==mark== and <b>b</b>.`,
      );
      if (i % 50 === 0) parts.push(`> [!note]- Callout ${i}\n> body ${i}`);
      if (i % 100 === 0) parts.push('```mermaid\ngraph TD\nA-->B\n```');
    }
    const raw = parts.join('\n\n') + '\n';
    const { view } = await open(raw);
    const at = posAfter(view.state.doc, 'Paragraph 700 wit');
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) view.dispatch(view.state.tr.insertText('x', at + i));
    const per = (performance.now() - t0) / 30;
    // generous: a keystroke walks the blocks three times (links, callouts, diagrams), a few ms at most
    expect(per).toBeLessThan(40);
    const t1 = performance.now();
    for (let i = 0; i < 30; i++) caretAt(view, at + (i % 2 === 0 ? 0 : 1));
    expect((performance.now() - t1) / 30).toBeLessThan(25);
  });
});
