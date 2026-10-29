import { useTranslation } from 'react-i18next';
import { commandById, commandTitle, isEnabled, runCommand } from '../commands/registry';
import { useManaged } from '../state/managed';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { AccountButton } from './AccountButton';
import { Icon, type IconName } from './icons';

/** Quick actions, top to bottom. Each one is a registry command (palette and hotkeys included). */
const ITEMS: { command: string; icon: IconName; gap?: boolean }[] = [
  { command: 'folder:new', icon: 'folderPlus' },
  { command: 'note:new', icon: 'filePlus' },
  { command: 'canvas:new', icon: 'canvas' },
  { command: 'drawing:new', icon: 'pencil' },
  { command: 'bases:new', icon: 'table' },
  { command: 'separator:insert', icon: 'separator', gap: true },
  { command: 'note:export-pdf', icon: 'pdf' },
  { command: 'note:export-image', icon: 'image' },
];

export function Ribbon() {
  const { t } = useTranslation();
  // Whether a command is enabled depends on these; subscribing re-evaluates it on change.
  useAppStore((s) => s.layout);
  useAppStore((s) => s.vault);
  useSync((s) => s);
  useManaged((s) => s.features);
  return (
    <nav className="ribbon" aria-label={t('ribbon.label')}>
      {ITEMS.map(({ command, icon, gap }) => {
        const c = commandById.get(command);
        const title = commandTitle(command);
        return (
          <button
            key={command}
            className={`icon${gap ? ' gap' : ''}`}
            title={title}
            aria-label={title}
            disabled={!c || !isEnabled(c)}
            onClick={() => void runCommand(command)}
          >
            <Icon name={icon} />
          </button>
        );
      })}
      <div className="ribbon-bottom">
        <button
          className="icon"
          title={t('settings.title')}
          aria-label={t('settings.title')}
          onClick={() => useAppStore.getState().openSettings()}
        >
          <Icon name="settings" />
        </button>
        <AccountButton />
      </div>
    </nav>
  );
}
