import { useTranslation } from 'react-i18next';
import { api } from '../app/api';
import { useRecentVaults } from '../state/queries';

export function Welcome({ onOpen }: { onOpen: (path: string) => Promise<void> }) {
  const { t } = useTranslation();
  const { data: recent = [] } = useRecentVaults();
  const pick = async () => {
    const path = await api.vault.pickFolder(t('welcome.pickTitle'));
    if (path) await onOpen(path);
  };
  return (
    <main className="welcome">
      <div className="card">
        <h1>{t('welcome.title')}</h1>
        <p className="muted">{t('welcome.subtitle')}</p>
        <button className="primary" onClick={() => void pick()}>
          {t('welcome.openFolder')}
        </button>
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
