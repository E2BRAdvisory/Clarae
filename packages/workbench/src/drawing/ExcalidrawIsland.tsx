// Renders its child in a React root of its own. The Excalidraw fork (zsviczian, see
// scripts/esbuild.mjs) does not survive the simulated unmount/remount of <StrictMode> in
// development: its class component destroys itself and cannot start again. A separate root
// keeps the rest of the app in StrictMode while the editor mounts exactly once.
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export function ExcalidrawIsland({ children }: { children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const root = useRef<Root | null>(null);

  useLayoutEffect(() => {
    // A fresh node per mount: StrictMode runs this effect twice and a container takes one root.
    const el = document.createElement('div');
    el.className = 'excalidraw-wrapper'; // the fork's CSS keys some layout rules on it
    el.style.height = '100%';
    (host.current as HTMLDivElement).append(el);
    const r = createRoot(el);
    root.current = r;
    r.render(children);
    return () => {
      root.current = null;
      // Not while React is committing: unmounting a root synchronously from a cleanup warns.
      queueMicrotask(() => {
        r.unmount();
        el.remove();
      });
    };
    // children is rendered by the effect below on every commit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    root.current?.render(children);
  });

  return <div ref={host} className="drawing-island" />;
}
