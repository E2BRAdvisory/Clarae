/** Calls `onIdle` once after `ms` without any input; every pointer, key or touch restarts the wait. */
export function watchIdle(ms: number, onIdle: () => void, target: Document = document): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const arm = (): void => {
    if (fired) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      onIdle();
    }, ms);
  };
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
  for (const e of events) target.addEventListener(e, arm, { passive: true });
  arm();
  return () => {
    clearTimeout(timer);
    for (const e of events) target.removeEventListener(e, arm);
  };
}
