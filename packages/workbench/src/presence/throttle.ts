// A trailing throttle where the latest value wins: the first call goes at once, those inside the window collapse
// into one that goes when it ends. `cancel` drops what is waiting (the view went away).
export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

export function throttleLatest<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  now: () => number = () => performance.now(),
): Throttled<A> {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: A | undefined;
  const run = (args: A): void => {
    last = now();
    fn(...args);
  };
  const throttled = ((...args: A): void => {
    const wait = last + ms - now();
    if (wait <= 0 && timer === undefined) return run(args);
    waiting = args;
    if (timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        const w = waiting;
        waiting = undefined;
        if (w) run(w);
      },
      Math.max(0, wait),
    );
  }) as Throttled<A>;
  throttled.cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    waiting = undefined;
  };
  return throttled;
}
