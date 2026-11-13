import { BrandMark } from '@clarae/ui';
import { useTranslation } from 'react-i18next';
import { useCan, usePlatform } from '../platform';
import { useRecentVaults } from '../state/queries';
import { ActionButton } from '../ui/ActionButton';

export function Welcome({ onOpen }: { onOpen: (path: string) => Promise<void> }) {
  const { t } = useTranslation();
  const { data: recent = [] } = useRecentVaults();
  const localFolders = useCan('localFolders');
  // The browser opens one vault per page: its other vaults are in the console, not in a recent list.
  const multiVault = useCan('multiVault');
  const backToConsole = usePlatform((s) => s.backToConsole);
  return (
    <main className="welcome">
      <div className="card">
        <div className="brand">
          <BrandMark size={48} />
          <div>
            <div className="name">{t('app.name')}</div>
            <div className="tagline">{t('app.tagline')}</div>
          </div>
        </div>
        <h1>{t('welcome.title')}</h1>
        <p className="muted">{t(localFolders ? 'welcome.subtitle' : 'welcome.subtitleWeb')}</p>
        <ActionButton id="vault:open-folder" arg={onOpen} className="primary" />
        {backToConsole && (
          <button className={localFolders ? undefined : 'primary'} onClick={backToConsole}>
            {t('app.backToConsole')}
          </button>
        )}
        {multiVault && recent.length > 0 && (
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
