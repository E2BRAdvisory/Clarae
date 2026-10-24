import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { useBacklinks } from '../state/queries';

export function BacklinksPanel({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const openNote = useAppStore((s) => s.openNote);
  const { data } = useBacklinks(vaultId, path);
  const linked = data?.linked ?? [];
  const mentions = data?.mentions ?? [];
  const label = (p: string) => p.replace(/\.md$/, '');

  return (
    <section className="backlinks" aria-label={t('backlinks.title')}>
      <h3>
        {t('backlinks.title')} ({linked.length})
      </h3>
      {linked.length === 0 && <div className="muted">{t('backlinks.none')}</div>}
      {linked.map((l, i) => (
        <div key={`${l.path}:${l.line}:${i}`} className="item" onClick={() => openNote(l.path)}>
          {label(l.path)} <span className="muted">· {t('backlinks.line', { n: l.line })}</span>
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
