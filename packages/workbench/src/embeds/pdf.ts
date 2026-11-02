// PDF embeds (![[doc.pdf#page=3]]) rendered with pdf.js, lazily loaded: one
// page on a canvas with previous/next buttons. <embed>/<iframe> are blocked by
// the CSP on purpose (object-src and frame-src are 'none').
import { i18next } from '../i18n';

/**
 * Renders the PDF into el; returns a disposer that stops the work and frees the pdf.js document
 * (its worker-side copy of the file, pages and fonts). `data` must be a copy the caller does not
 * keep: pdf.js transfers it to its worker.
 */
export function renderPdf(
  el: HTMLElement,
  path: string,
  data: () => Promise<Uint8Array>,
  startPage: number,
): () => void {
  el.classList.add('embed-pdf');
  el.textContent = path;
  let disposed = false;
  let release: (() => void) | null = null;
  let stop: (() => void) | null = null;
  void (async () => {
    const pdfjs = await import('pdfjs-dist');
    const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    const bytes = await data();
    if (disposed) return;
    const task = pdfjs.getDocument({ data: bytes });
    release = () => void task.destroy(); // stops the load, or frees the loaded document
    const doc = await task.promise;
    if (disposed) return;
    let page = Math.min(Math.max(1, startPage), doc.numPages);

    const bar = document.createElement('div');
    bar.className = 'embed-pdf-bar';
    const prev = document.createElement('button');
    prev.textContent = '‹';
    prev.setAttribute('aria-label', i18next.t('embeds.pdfPrev'));
    const next = document.createElement('button');
    next.textContent = '›';
    next.setAttribute('aria-label', i18next.t('embeds.pdfNext'));
    const label = document.createElement('span');
    const canvas = document.createElement('canvas');
    bar.append(prev, label, next);
    el.replaceChildren(bar, canvas);

    // One render at a time on the canvas: pdf.js refuses a second one while the first runs, so a
    // newer page (or the disposal) cancels the one in progress.
    let rendering: { cancel(): void } | null = null;
    stop = () => {
      rendering?.cancel();
      rendering = null;
    };
    const draw = async (): Promise<void> => {
      const want = page;
      label.textContent = `${path.split('/').pop() ?? ''} — ${want}/${doc.numPages}`;
      const p = await doc.getPage(want);
      if (disposed || want !== page) return; // gone, or a newer page was asked for meanwhile
      rendering?.cancel();
      rendering = null;
      const viewport = p.getViewport({ scale: 1.25 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const task = p.render({ canvasContext: ctx, viewport, canvas });
      rendering = task;
      try {
        await task.promise;
      } catch (e) {
        if (disposed || rendering !== task) return; // cancelled for a newer page or the disposal
        throw e;
      } finally {
        if (rendering === task) rendering = null;
      }
    };
    // A page turn that fails (cancelled by a newer one, or after dispose) has nothing to report.
    const show = (): void => void draw().catch(() => undefined);
    prev.onclick = () => {
      if (page > 1) {
        page--;
        show();
      }
    };
    next.onclick = () => {
      if (page < doc.numPages) {
        page++;
        show();
      }
    };
    await draw();
  })().catch(() => {
    if (!disposed) el.textContent = `📄 ${path}`;
  });
  return () => {
    if (disposed) return;
    disposed = true;
    stop?.();
    stop = null;
    release?.();
    release = null;
  };
}
