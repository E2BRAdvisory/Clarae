import { useTranslation } from 'react-i18next';
import { BookmarksPanel } from '../bookmarks/BookmarksPanel';
import { useBacklinks } from '../state/queries';
import { selectActivePath, useAppStore } from '../state/store';
import { BacklinksPanel } from './BacklinksPanel';

const name = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

/** Links written in the note in focus; unresolved ones are shown as such and cannot be opened. */
function OutgoingLinks({ vaultId, path }: { vaultId: string; path: string }) {
  const { t } = useTranslation();
  const openNote = useAppStore((s) => s.openNote);
  const { data } = useBacklinks(vaultId, path);
  const seen = new Set<string>();
  const links = (data?.outgoing ?? []).filter((l) => {
    const key = `${l.path}|${l.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <section className="backlinks" aria-label={t('links.outgoing')}>
      <h3>
        {t('links.outgoing')} ({links.length})
      </h3>
      {links.length === 0 && <div className="muted">{t('links.none')}</div>}
      {links.map((l) =>
        l.resolved ? (
          <div
            key={`${l.path}|${l.raw}`}
            className="item"
            title={l.path}
            onClick={() =>
              openNote(l.path, {
                ...(l.heading ? { heading: l.heading } : {}),
                ...(l.block ? { block: l.block } : {}),
              })
            }
          >
            {l.alias || name(l.path)}
          </div>
        ) : (
          <div key={`${l.path}|${l.raw}`} className="item muted" title={t('links.unresolved')}>
            {l.alias || l.raw}
          </div>
        ),
      )}
    </section>
  );
}

/** Right sidebar, "Links" tab: links and backlinks of the note in focus, and the vault bookmarks. */
export function LinksPanel({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const path = useAppStore(selectActivePath);
  return (
    <div className="content links-panel">
      {path ? (
        <>
          <OutgoingLinks vaultId={vaultId} path={path} />
          <BacklinksPanel vaultId={vaultId} path={path} />
        </>
      ) : (
        <div className="muted pad">{t('outline.none')}</div>
      )}
      <section className="links-bookmarks" aria-label={t('bookmarks.title')}>
        <h3>{t('bookmarks.title')}</h3>
        <BookmarksPanel vaultId={vaultId} />
      </section>
    </div>
  );
}
