// `![[x.base]]` / `![[x.base#View]]` inside notes (Live Preview widgets and Reading view both go
// through embeds/hydrate.ts, which calls this). A small React root is mounted into the embed
// element and torn down when the element leaves the document.
import { createRoot, type Root } from 'react-dom/client';
import { useAppStore } from '../state/store';
import { BaseEmbed } from './BaseView';

const mounted = new WeakMap<HTMLElement, Root>();

export function mountBaseEmbed(
  el: HTMLElement,
  vaultId: string,
  path: string,
  viewName: string,
  fromPath: string,
): () => void {
  mounted.get(el)?.unmount();
  const root = createRoot(el);
  mounted.set(el, root);
  const unmount = (): void => {
    if (mounted.get(el) !== root) return;
    mounted.delete(el);
    root.unmount();
  };
  let seenConnected = false;
  const isAlive = (): boolean => {
    if (el.isConnected) seenConnected = true;
    return el.isConnected || !seenConnected;
  };
  root.render(
    <BaseEmbed
      vaultId={vaultId}
      path={path}
      viewName={viewName.trim()}
      thisPath={fromPath}
      isAlive={isAlive}
      onDetached={() => setTimeout(unmount, 0)}
      onOpen={() => useAppStore.getState().openNote(path, { newTab: true })}
    />,
  );
  // Deferred: the embed may be discarded while React is rendering (a widget destroyed by an
  // editor update), when a root cannot be unmounted synchronously.
  return () => void setTimeout(unmount, 0);
}
