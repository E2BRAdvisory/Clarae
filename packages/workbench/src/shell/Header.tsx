import { BrandMark } from '@clarae/ui';
import { useTranslation } from 'react-i18next';
import { effectiveTheme, type Theme } from '../app/theme';
import { commandTitle, runCommand } from '../commands/registry';
import { usePlatform } from '../platform';
import { useAppStore } from '../state/store';
import { Icon, type IconName } from './icons';
import { VaultStatus } from './VaultStatus';

function HeaderButton({
  command,
  icon,
  pressed,
}: {
  command: string;
  icon: IconName;
  pressed?: boolean;
}) {
  const title = commandTitle(command);
  return (
    <button
      className="icon"
      title={title}
      aria-label={title}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      onClick={() => void runCommand(command)}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Header() {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const leftOpen = useAppStore((s) => s.left.open);
  const rightOpen = useAppStore((s) => s.right.open);
  const theme = useAppStore((s) => s.settings.theme);
  const dark = effectiveTheme((theme || 'system') as Theme) === 'dark';
  const backToConsole = usePlatform((s) => s.backToConsole);
  return (
    <header className="titlebar">
      {backToConsole && (
        <button className="back-to-console" onClick={backToConsole}>
          {t('app.backToConsole')}
        </button>
      )}
      {vault && (
        <div className="header-group">
          <HeaderButton command="sidebar:left" icon="sidebarLeft" pressed={leftOpen} />
          <HeaderButton command="search:vault" icon="search" />
        </div>
      )}
      {!vault && <BrandMark size={20} />}
      <span className="title" title={vault?.path}>
        {vault ? vault.name : t('app.name')}
      </span>
      <span className="spacer" />
      {vault && !rightOpen && <VaultStatus />}
      {vault && <HeaderButton command="palette:open" icon="command" />}
      <HeaderButton command="theme:toggle" icon={dark ? 'sun' : 'moon'} />
      {/* With a vault open, settings and the account are at the bottom of the ribbon. */}
      {!vault && (
        <button
          className="icon"
          title={t('settings.title')}
          aria-label={t('settings.title')}
          onClick={() => useAppStore.getState().openSettings()}
        >
          <Icon name="settings" />
        </button>
      )}
      {vault && <HeaderButton command="sidebar:right" icon="sidebarRight" pressed={rightOpen} />}
    </header>
  );
}
