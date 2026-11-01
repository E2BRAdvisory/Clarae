// PDF embeds (![[doc.pdf#page=3]]) rendered with pdf.js, lazily loaded: one
// page on a canvas with previous/next buttons. <embed>/<iframe> are blocked by
// the CSP on purpose (object-src and frame-src are 'none').

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
    const next = document.createElement('button');
    next.textContent = '›';
    const label = document.createElement('span');
    const canvas = document.createElement('canvas');
    bar.append(prev, label, next);
    el.replaceChildren(bar, canvas);

    const draw = async (): Promise<void> => {
      label.textContent = `${path.split('/').pop() ?? ''} — ${page}/${doc.numPages}`;
      const p = await doc.getPage(page);
      if (disposed) return;
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
    if (!disposed) el.textContent = `📄 ${path}`;
  });
  return () => {
    if (disposed) return;
    disposed = true;
    release?.();
    release = null;
  };
}
