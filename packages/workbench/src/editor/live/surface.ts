// The Live editor's handle on the Milkdown editor behind it, without the screen: the parser, the
// serializer and the Markdown tree of the editor, as the fidelity layer (fidelity/session.ts) needs
// them. The headless editor of the tests and the real one of the application get it the same way, so
// the layer is proven on the very pipeline the user types into.
import {
  editorStateOptionsCtx,
  editorViewCtx,
  parserCtx,
  prosePluginsCtx,
  remarkCtx,
  schemaCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import type { Editor } from '@milkdown/kit/core';
import { SerializerState } from '@milkdown/kit/transformer';
import { $remark } from '@milkdown/kit/utils';
import type { Node as PMNode, Schema } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Root } from 'mdast';
import type { Processor } from 'unified';
import { liveOptions } from './ofm/options';

type RemarkProcessor = Processor<Root, undefined, undefined, Root, string>;

export interface EditorSurface {
  editor: Editor;
  schema: Schema;
  view: EditorView;
  /** The remark processor of the editor, the transformers of the layer included. */
  remark: RemarkProcessor;
  /** The mdast the parser works on (positions kept), after the transformers. */
  mdast(md: string, forceRaw?: ReadonlySet<number>): Root;
  /** Markdown to document: the parser alone. */
  parse(md: string, forceRaw?: ReadonlySet<number>): PMNode;
  /**
   * Markdown to document as the view holds it after loading: the plugins that adjust the document
   * on load (the heading ids) have run. This is the document the block table is built on, and the
   * view is left showing it (its state is replaced: no transaction, no history).
   */
  load(md: string, forceRaw?: ReadonlySet<number>): PMNode;
  /** The Markdown tree of a text as the parser reads it, before any transformer (positions kept). */
  parseTree(md: string): Root;
  /** The whole document, serialized by Milkdown with the default style. */
  serialize(doc: PMNode): string;
  /** A function that serializes a document with the given remark-stringify settings. */
  serializer(settings: Record<string, unknown>): (doc: PMNode) => string;
}

/**
 * Remembers the tree of the last parse as the parser got it: the block table is built from it (one
 * parse of the file, not two). Call before `create()`; the returned function builds the surface after
 * it.
 */
export function captureSurface(editor: Editor): () => EditorSurface {
  let last: { md: string; forceRaw: ReadonlySet<number>; tree: Root } | null = null;
  editor.use(
    $remark('liveTree', (ctx) => () => (tree: Root, file: { value?: unknown }) => {
      last = {
        md: typeof file.value === 'string' ? file.value : '',
        forceRaw: ctx.get(liveOptions.key).forceRaw,
        tree,
      };
    }),
  );
  return () => {
    let surface!: EditorSurface;
    editor.action((ctx) => {
      const remark = ctx.get(remarkCtx);
      const schema = ctx.get(schemaCtx);
      const view = ctx.get(editorViewCtx);
      surface = {
        editor,
        schema,
        view,
        remark,
        mdast: (md, forceRaw) => {
          const raw = forceRaw ?? new Set<number>();
          if (
            last?.md === md &&
            last.forceRaw.size === raw.size &&
            [...raw].every((k) => last?.forceRaw.has(k))
          ) {
            return last.tree;
          }
          ctx.set(liveOptions.key, { forceRaw: raw });
          return remark.runSync(remark.parse(md), md) as Root;
        },
        parse: (md, forceRaw) => {
          ctx.set(liveOptions.key, { forceRaw: forceRaw ?? new Set() });
          return ctx.get(parserCtx)(md);
        },
        load: (md, forceRaw) => {
          ctx.set(liveOptions.key, { forceRaw: forceRaw ?? new Set() });
          const doc = ctx.get(parserCtx)(md);
          const state = EditorState.create(
            ctx.get(editorStateOptionsCtx)({ schema, doc, plugins: ctx.get(prosePluginsCtx) }),
          );
          view.updateState(state);
          return view.state.doc;
        },
        parseTree: (md) => remark.parse(md),
        serialize: ctx.get(serializerCtx),
        serializer: (settings) => {
          const processor = remark.copy().data('settings', settings);
          return SerializerState.create(schema, processor);
        },
      };
    });
    return surface;
  };
}
