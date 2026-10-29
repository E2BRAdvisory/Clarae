// ```query blocks in the two views: Live Preview (block widget) and Reading view (hydrate).
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import { blockDecorations, blockWidgets, scanBlocks } from '../editor/blockWidgets';
import { defaultContext, livePreviewContext, type LivePreviewContext } from '../editor/context';
import { hydrate, type EmbedBackend } from '../embeds/hydrate';
import { renderMarkdown } from '../reading/render';
import { QueryWidget } from './widget';

const doc = 'Intro\n\n```query\ntag:#todo\nsort: name\n```\n\nOutro\n';

function stateFor(cursor: number, ctx: LivePreviewContext = defaultContext): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), blockWidgets(), livePreviewContext.of(ctx)],
  });
}

describe('query block in Live Preview', () => {
  it('is found as a block with its source', () => {
    const blocks = scanBlocks(stateFor(0));
    expect(blocks.map((b) => b.kind)).toEqual(['query']);
    expect(blocks[0]?.data.trim()).toBe('tag:#todo\nsort: name');
  });

  it('is replaced by a widget, and shows its source while the caret is inside', () => {
    const widgets = (st: EditorState): string[] => {
      const out: string[] = [];
      blockDecorations(st).between(0, doc.length, (_f, _t, v) => {
        const w = (v.spec as { widget?: object }).widget;
        if (w) out.push(w.constructor.name);
      });
      return out;
    };
    expect(widgets(stateFor(0))).toEqual(['QueryWidget']);
    expect(widgets(stateFor(doc.indexOf('tag:')))).toEqual([]);
  });

  it('asks the context to render the source into its element, and compares by source', () => {
    const renderQuery = vi.fn((source: string, el: HTMLElement) => void (el.dataset['q'] = source));
    const view = {
      state: stateFor(0, { ...defaultContext, renderQuery }),
    } as unknown as EditorView;
    const el = new QueryWidget('tag:#todo').toDOM(view);
    expect(el.className).toBe('cm-lp-query');
    expect(renderQuery).toHaveBeenCalledWith('tag:#todo', el);
    expect(new QueryWidget('a').eq(new QueryWidget('a'))).toBe(true);
    expect(new QueryWidget('a').eq(new QueryWidget('b'))).toBe(false);
  });

  it('falls back to the source when the context cannot render queries', () => {
    const view = { state: stateFor(0) } as unknown as EditorView;
    expect(new QueryWidget('tag:#todo').toDOM(view).textContent).toBe('tag:#todo');
  });
});

describe('query block in Reading view', () => {
  const backend: EmbedBackend = {
    resolve: () => Promise.resolve(''),
    readNote: () => Promise.resolve(''),
    readBinary: () => Promise.reject(new Error('none')),
  };
  const deps = (renderQuery?: (el: HTMLElement, source: string, from: string) => void) => ({
    backend,
    fromPath: 'Host.md',
    depth: 0,
    visited: ['Host.md'],
    ...(renderQuery ? { renderQuery } : {}),
  });

  it('hands the block source and host note to the query renderer', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('Before\n\n```query\ntag:#todo\nlimit: 3\n```\n\nAfter');
    const renderQuery = vi.fn((el: HTMLElement) => void (el.className = 'query-block'));
    hydrate(root, deps(renderQuery));
    expect(renderQuery).toHaveBeenCalledTimes(1);
    expect(renderQuery.mock.calls[0]?.slice(1)).toEqual(['tag:#todo\nlimit: 3\n', 'Host.md']);
    expect(root.querySelector('.query-block')).not.toBeNull();
    expect(root.querySelector('pre')).toBeNull();
  });

  it('leaves other code blocks alone', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdown('```js\nlet a = 1\n```');
    const renderQuery = vi.fn();
    hydrate(root, deps(renderQuery));
    expect(renderQuery).not.toHaveBeenCalled();
    expect(root.querySelector('pre')).not.toBeNull();
  });
});
