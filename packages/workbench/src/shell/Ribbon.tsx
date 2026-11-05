import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { classify, type EmbedKind } from '../embeds/media';
import { commandById, commandTitle, isEnabled, runCommand } from '../commands/registry';
import { getSceneController, subscribeSceneController } from '../drawing/actions/active';
import { useManaged } from '../state/managed';
import { selectActivePath, useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { AccountButton } from './AccountButton';
import { Icon, type IconName } from './icons';

type Item = { command: string; icon: IconName; gap?: boolean };

/** Quick actions, top to bottom. Each one is a registry command (palette and hotkeys included). */
const ITEMS: Item[] = [
  { command: 'folder:new', icon: 'folderPlus' },
  { command: 'note:new', icon: 'filePlus' },
  { command: 'canvas:new', icon: 'canvas' },
  { command: 'drawing:new', icon: 'pencil' },
  { command: 'bases:new', icon: 'table' },
  { command: 'marp:new', icon: 'slides' },
  { command: 'separator:insert', icon: 'separator', gap: true },
];

/** The export buttons of each kind of file in focus (none for the other kinds). */
const EXPORTS: Partial<Record<EmbedKind, Item[]>> = {
  note: [
    { command: 'note:export-pdf', icon: 'pdf' },
    { command: 'note:export-image', icon: 'image' },
    { command: 'note:export-html', icon: 'html' },
  ],
  drawing: [
    { command: 'drawing:export-png', icon: 'png' },
    { command: 'drawing:export-svg', icon: 'svg' },
    { command: 'drawing:export-pdf', icon: 'pdf' },
  ],
  presentation: [
    { command: 'marp:export-html', icon: 'html' },
    { command: 'marp:export-pdf', icon: 'pdf' },
    { command: 'marp:export-pptx', icon: 'pptx' },
  ],
};

export function Ribbon() {
  const { t } = useTranslation();
  // Whether a command is enabled depends on these; subscribing re-evaluates it on change.
  useAppStore((s) => s.layout);
  const activePath = useAppStore(selectActivePath);
  // The drawing exports are enabled while a drawing editor is mounted (it registers late: lazy).
  useSyncExternalStore(subscribeSceneController, getSceneController);
  useAppStore((s) => s.vault);
  useSync((s) => s);
  useManaged((s) => s.features);
  const exports = activePath ? (EXPORTS[classify(activePath)] ?? []) : [];
  const items = exports.length
    ? [...ITEMS, ...exports.map((x, i) => (i ? x : { ...x, gap: true }))]
    : ITEMS;
  return (
    <nav className="ribbon" aria-label={t('ribbon.label')}>
      {items.map(({ command, icon, gap }) => {
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
