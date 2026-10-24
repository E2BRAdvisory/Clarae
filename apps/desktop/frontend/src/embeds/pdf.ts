// PDF embeds (![[doc.pdf#page=3]]) rendered with pdf.js, lazily loaded: one
// page on a canvas with previous/next buttons. <embed>/<iframe> are blocked by
// the CSP on purpose (object-src and frame-src are 'none').
import { bytesOf } from './media';
import type { BinaryContent } from '../app/api';

export function renderPdf(el: HTMLElement, bin: BinaryContent, startPage: number): void {
  el.classList.add('embed-pdf');
  el.textContent = bin.path;
  void (async () => {
    const pdfjs = await import('pdfjs-dist');
    const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    const doc = await pdfjs.getDocument({ data: bytesOf(bin) }).promise;
    let page = Math.min(Math.max(1, startPage), doc.numPages);

    const bar = document.createElement('div');
    bar.className = 'embed-pdf-bar';
    const prev = document.createElement('button');
    prev.textContent = '‹';
    const next = document.createElement('button');
    next.textContent = '›';
    const label = document.createElement('span');
    const canvas = document.createElement('canvas');
    bar.append(prev, label, next);
    el.replaceChildren(bar, canvas);

    const draw = async (): Promise<void> => {
      label.textContent = `${bin.path.split('/').pop() ?? ''} — ${page}/${doc.numPages}`;
      const p = await doc.getPage(page);
      const viewport = p.getViewport({ scale: 1.25 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (ctx) await p.render({ canvasContext: ctx, viewport, canvas }).promise;
    };
    prev.onclick = () => {
      if (page > 1) {
        page--;
        void draw();
      }
    };
    next.onclick = () => {
      if (page < doc.numPages) {
        page++;
        void draw();
      }
    };
    await draw();
  })().catch(() => {
    el.textContent = `📄 ${bin.path}`;
  });
}
