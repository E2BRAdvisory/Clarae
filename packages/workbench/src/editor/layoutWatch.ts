// "The place of the text on the screen may have changed": the one way both engines tell it (NoteEditorHandle.
// onLayout). The scroll container, the window and the size of the editor are watched, and so is its content, which
// a text edit changes; the listener runs at most once per frame.
export function watchLayout(
  scroller: HTMLElement,
  content: HTMLElement,
  listener: () => void,
): () => void {
  let frame = 0;
  const fire = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      listener();
    });
  };
  scroller.addEventListener('scroll', fire, { passive: true });
  window.addEventListener('resize', fire);
  const size = typeof ResizeObserver === 'function' ? new ResizeObserver(fire) : null;
  size?.observe(scroller);
  const edits = typeof MutationObserver === 'function' ? new MutationObserver(fire) : null;
  edits?.observe(content, { childList: true, subtree: true, characterData: true });
  return () => {
    scroller.removeEventListener('scroll', fire);
    window.removeEventListener('resize', fire);
    size?.disconnect();
    edits?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
}

/** Whether a point is inside the box of the editor (a place scrolled out of it is not shown). */
export function insideBox(p: { x: number; y: number }, box: DOMRect): boolean {
  return p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
}
