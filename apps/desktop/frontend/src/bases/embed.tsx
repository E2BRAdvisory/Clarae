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
): void {
  mounted.get(el)?.unmount();
  const root = createRoot(el);
  mounted.set(el, root);
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
      onDetached={() => setTimeout(() => root.unmount(), 0)}
      onOpen={() => useAppStore.getState().openNote(path, { newTab: true })}
    />,
  );
}
