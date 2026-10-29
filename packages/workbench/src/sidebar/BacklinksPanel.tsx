import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { useBacklinks } from '../state/queries';
import { openLocalGraph } from '../graph/commands';
import { Icon } from '../shell/icons';

export function BacklinksPanel({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const openNote = useAppStore((s) => s.openNote);
  const { data } = useBacklinks(vaultId, path);
  const linked = data?.linked ?? [];
  const mentions = data?.mentions ?? [];
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  // A drawing or a canvas links to the note too: labelled by what it is, without a line number.
  const label = (p: string) =>
    /\.excalidraw$/i.test(p)
      ? t('backlinks.drawing', { name: name(p) })
      : /\.canvas$/i.test(p)
        ? t('backlinks.canvas', { name: name(p) })
        : p.replace(/\.md$/, '');
  const hasLines = (p: string) => /\.md$/i.test(p);

  return (
    <section className="backlinks" aria-label={t('backlinks.title')}>
      <h3>
        {t('backlinks.title')} ({linked.length}){' '}
        {/\.md$/i.test(path) && (
          <button
            type="button"
            className="icon"
            title={t('backlinks.localGraph')}
            aria-label={t('backlinks.localGraph')}
            onClick={() => openLocalGraph(path)}
          >
            <Icon name="locate" />
          </button>
        )}
      </h3>
      {linked.length === 0 && <div className="muted">{t('backlinks.none')}</div>}
      {linked.map((l, i) => (
        <div
          key={`${l.path}:${l.line}:${i}`}
          className="item"
          onClick={() => openNote(l.path, hasLines(l.path) ? { line: l.line } : {})}
        >
          {label(l.path)}
          {hasLines(l.path) && (
            <span className="muted"> · {t('backlinks.line', { n: l.line })}</span>
          )}
        </div>
      ))}
      {mentions.length > 0 && (
        <>
          <h3>
            {t('backlinks.mentions')} ({mentions.length})
          </h3>
          {mentions.map((m) => (
            <div key={m.path} className="item" onClick={() => openNote(m.path)} title={m.snippet}>
              {label(m.path)}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
