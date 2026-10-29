import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { configureExcalidrawAssets } from './excalidraw';

// Excalidraw is large: it is fetched when the first drawing is opened, never at startup.
const DrawingEditor = lazy(() => {
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
