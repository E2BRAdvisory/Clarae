import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { configureExcalidrawAssets } from './excalidraw';
import { lazyView } from '../ui/lazyView';

// Excalidraw is large: it is fetched when the first drawing is opened, never at startup (a failed
// download is retried; the pane's error boundary offers a retry after that).
const DrawingEditor = lazyView(() => {
  configureExcalidrawAssets();
  return import('./DrawingEditor');
});

/** The tab of a .excalidraw file. */
export function DrawingView({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<div className="note-loading muted">{t('drawing.loading')}</div>}>
      <DrawingEditor vaultId={vaultId} path={path} />
    </Suspense>
  );
}
