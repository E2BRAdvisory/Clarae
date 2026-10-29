import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { useCan, usePlatform } from '../platform';
import { useRecentVaults } from '../state/queries';

export function Welcome({ onOpen }: { onOpen: (path: string) => Promise<void> }) {
  const { t } = useTranslation();
  const { data: recent = [] } = useRecentVaults();
  const localFolders = useCan('localFolders');
  const backToConsole = usePlatform((s) => s.backToConsole);
  const pick = async () => {
    const path = await api.vault.pickFolder(t('welcome.pickTitle'));
    if (path) await onOpen(path);
  };
  return (
    <main className="welcome">
      <div className="card">
        <h1>{t('welcome.title')}</h1>
        <p className="muted">{t(localFolders ? 'welcome.subtitle' : 'welcome.subtitleWeb')}</p>
        {localFolders && (
          <button className="primary" onClick={() => void pick()}>
            {t('welcome.openFolder')}
          </button>
        )}
        {backToConsole && (
          <button className={localFolders ? undefined : 'primary'} onClick={backToConsole}>
            {t('app.backToConsole')}
          </button>
        )}
        {recent.length > 0 && (
          <div className="recent">
            <h3>{t('welcome.recent')}</h3>
            {recent.map((v) => (
              <button key={v.path} onClick={() => void onOpen(v.path)}>
                {v.name}
                <span className="path">{v.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
