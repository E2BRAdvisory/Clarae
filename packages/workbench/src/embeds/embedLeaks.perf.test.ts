// Resource counts of Live Preview embeds: binary reads, object URLs and pdf.js documents when
// widgets are recreated (scrolling) and when notes are switched. CodeMirror calls toDOM when a
// widget enters the viewport and destroy when it leaves it (or the editor goes away), which is
// exactly what these scenarios do. Before the attachment cache and the widget disposers they were:
//   (d1) 5 scroll passes over 30 images: resolve 150, readBinary 150, object URLs created 30, revoked 0
//   (d2) 10 note switches (30 images + 1 PDF each): readBinary 310, URLs created 300, revoked 0,
//        300 still alive, 10 pdf.js documents alive (none destroyed)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { defaultContext, livePreviewContext, type LivePreviewContext } from '../editor/context';
import { EmbedWidget } from '../editor/widgets';
import { renderEmbedInto, type EmbedBackend } from './hydrate';
import { mediaLimits, mediaStats, releaseVaultMedia } from './media';
import type { BinaryContent } from '../app/api';

const pdf = vi.hoisted(() => ({ loaded: 0, destroyed: 0 }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => {
    const doc = {
      numPages: 1,
      getPage: () =>
        Promise.resolve({
          getViewport: () => ({ width: 1, height: 1 }),
          render: () => ({ promise: Promise.resolve() }),
        }),
    };
    pdf.loaded++;
    // pdf.js 6: the loading task frees the document (PDFDocumentProxy has no destroy any more).
    return {
      promise: Promise.resolve(doc),
      destroy: () => {
        pdf.destroyed++;
        return Promise.resolve();
      },
    };
  },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }));

declare const process: { stderr: { write(s: string): boolean } };
// Vitest swallows console output of passing tests here: write the figures straight to stderr.
const report = (...parts: unknown[]): void => void process.stderr.write(parts.join(' ') + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let calls: { resolve: number; readBinary: number; created: number; revoked: number };
let live: Set<string>;

function binary(path: string): BinaryContent {
  const mime = path.endsWith('.pdf') ? 'application/pdf' : 'image/png';
  return { path, mime, data: btoa(`bytes of ${path}`), size: `bytes of ${path}`.length };
}

const backend = {
  resolve: (_from: string, target: string) => {
    calls.resolve++;
    return Promise.resolve(target);
  },
  readNote: () => Promise.resolve(''),
  readBinary: (path: string) => {
    calls.readBinary++;
    return Promise.resolve(binary(path));
  },
  // What the tree cache knows about the file (size and modification time).
  stat: (path: string) => ({ size: binary(path).size, mtime: '2026-01-01T00:00:00Z' }),
} as EmbedBackend;

function view(): EditorView {
  const ctx: LivePreviewContext = {
    ...defaultContext,
    renderEmbed: (spec, el) =>
      renderEmbedInto(el, spec, { backend, fromPath: 'Host.md', depth: 0, visited: ['Host.md'] }),
  };
  return new EditorView({
    state: EditorState.create({ extensions: [livePreviewContext.of(ctx)] }),
  });
}

const spec = (target: string) => ({ target, heading: '', block: '', alias: '', embed: true });

/** Shows the widgets (toDOM), lets their renders finish, then removes them (destroy). */
async function showThenHide(v: EditorView, widgets: EmbedWidget[]): Promise<void> {
  const doms = widgets.map((w) => w.toDOM(v));
  for (let i = 0; i < 5; i++) await sleep(5);
  widgets.forEach((w, i) => w.destroy(doms[i] as HTMLElement));
  for (let i = 0; i < 3; i++) await sleep(5);
}

beforeEach(() => {
  releaseVaultMedia('');
  calls = { resolve: 0, readBinary: 0, created: 0, revoked: 0 };
  live = new Set();
  pdf.loaded = 0;
  pdf.destroyed = 0;
  let n = 0;
  URL.createObjectURL = () => {
    calls.created++;
    const url = `blob:mock/${n++}`;
    live.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    calls.revoked++;
    live.delete(url);
  };
});

afterEach(() => vi.restoreAllMocks());

// Counts resources, not time: a generous timeout keeps it stable on a loaded machine.
describe('embed resources', { timeout: 30_000 }, () => {
  it('(d1) scrolling a note with 30 image embeds back and forth 5 times', async () => {
    const v = view();
    const widgets = Array.from({ length: 30 }, (_, i) => new EmbedWidget(spec(`scroll${i}.png`)));
    for (let pass = 0; pass < 5; pass++) await showThenHide(v, widgets);
    report('[perf d1] 5 scroll passes over 30 images:', JSON.stringify(calls));
    v.destroy();
    expect(calls.readBinary).toBe(30);
    expect(calls.created).toBe(30);
  });

  it('(d2) switching between 10 notes of 30 images and a PDF each', async () => {
    const v = view();
    for (let note = 0; note < 10; note++) {
      const widgets = [
        ...Array.from({ length: 30 }, (_, i) => new EmbedWidget(spec(`n${note}/img${i}.png`))),
        new EmbedWidget(spec(`n${note}/doc.pdf`)),
      ];
      await showThenHide(v, widgets);
    }
    const pdfAlive = pdf.loaded - pdf.destroyed;
    report(
      '[perf d2] 10 note switches:',
      JSON.stringify({ ...calls, liveUrls: live.size, pdfAlive, cache: mediaStats() }),
    );
    v.destroy();
    expect(pdfAlive).toBe(0);
    expect(live.size).toBeLessThanOrEqual(mediaLimits.entries);
    releaseVaultMedia(''); // the vault is closed
    report('[perf d2] after closing the vault:', JSON.stringify({ liveUrls: live.size }));
    expect(live.size).toBe(0);
  });
});
