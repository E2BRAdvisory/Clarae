// Resource counts of the embeds of the Live editor: binary reads, object URLs and pdf.js documents when
// the views are recreated (scrolling) and when notes are switched. A view of the Live editor renders its
// embed through `context.renderEmbed` when it enters the document and releases what that returned when
// it leaves it (or the editor goes away), which is exactly what these scenarios do (live/views/wikilink.ts
// does the same, with the same `release`). Before the attachment cache and the disposers they were:
//   (d1) 5 scroll passes over 30 images: resolve 150, readBinary 150, object URLs created 30, revoked 0
//   (d2) 10 note switches (30 images + 1 PDF each): readBinary 310, URLs created 300, revoked 0,
//        300 still alive, 10 pdf.js documents alive (none destroyed)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultContext, type EmbedDisposer, type LivePreviewContext } from '../editor/context';
import type { LinkSpec } from '../editor/types';
import { release } from '../editor/live/views/host';
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

const ctx: LivePreviewContext = {
  ...defaultContext,
  renderEmbed: (spec, el) =>
    renderEmbedInto(el, spec, { backend, fromPath: 'Host.md', depth: 0, visited: ['Host.md'] }),
};

const spec = (target: string): LinkSpec => ({
  target,
  heading: '',
  block: '',
  alias: '',
  embed: true,
});

/** What a view of the Live editor holds for an embed: its element and what the render returned. */
class EmbedView {
  private held: EmbedDisposer | void = undefined;
  readonly el = document.createElement('span');
  constructor(readonly spec: LinkSpec) {}
  show(): void {
    this.held = ctx.renderEmbed(this.spec, this.el);
  }
  destroy(): void {
    release(this.held);
    this.held = undefined;
  }
}

/** Shows the views (render), lets their renders finish, then removes them (destroy). */
async function showThenHide(views: EmbedView[]): Promise<void> {
  views.forEach((v) => v.show());
  for (let i = 0; i < 5; i++) await sleep(5);
  views.forEach((v) => v.destroy());
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
    const views = Array.from({ length: 30 }, (_, i) => new EmbedView(spec(`scroll${i}.png`)));
    for (let pass = 0; pass < 5; pass++) await showThenHide(views);
    report('[perf d1] 5 scroll passes over 30 images:', JSON.stringify(calls));
    expect(calls.readBinary).toBe(30);
    expect(calls.created).toBe(30);
  });

  it('(d2) switching between 10 notes of 30 images and a PDF each', async () => {
    for (let note = 0; note < 10; note++) {
      const views = [
        ...Array.from({ length: 30 }, (_, i) => new EmbedView(spec(`n${note}/img${i}.png`))),
        new EmbedView(spec(`n${note}/doc.pdf`)),
      ];
      await showThenHide(views);
    }
    const pdfAlive = pdf.loaded - pdf.destroyed;
    report(
      '[perf d2] 10 note switches:',
      JSON.stringify({ ...calls, liveUrls: live.size, pdfAlive, cache: mediaStats() }),
    );
    expect(pdfAlive).toBe(0);
    expect(live.size).toBeLessThanOrEqual(mediaLimits.entries);
    releaseVaultMedia(''); // the vault is closed
    report('[perf d2] after closing the vault:', JSON.stringify({ liveUrls: live.size }));
    expect(live.size).toBe(0);
  });
});
