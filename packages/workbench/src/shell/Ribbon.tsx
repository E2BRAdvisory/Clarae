import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Feature } from '@clarae/api-client/features';
import { classify, type EmbedKind } from '../embeds/media';
import {
  commandById,
  commandTitle,
  isAvailable,
  isEnabled,
  runCommand,
} from '../commands/registry';
import { getSceneController, subscribeSceneController } from '../drawing/actions/active';
import { featureOn, useManaged } from '../state/managed';
import { selectActivePath, useAppStore } from '../state/store';
import { useSync } from '../state/sync';
import { readOnlyVault } from '../terminal/commands';
import { terminalOpen, useTerminal } from '../terminal/store';
import { AccountButton } from './AccountButton';
import { Icon, type IconName } from './icons';

type Item = { command: string; icon: IconName; gap?: boolean; flag?: Feature };

/** Quick actions, top to bottom. Each one is a registry command (palette and hotkeys included). */
const ITEMS: Item[] = [
  { command: 'folder:new', icon: 'folderPlus' },
  { command: 'note:new', icon: 'filePlus' },
  { command: 'canvas:new', icon: 'canvas' },
  { command: 'drawing:new', icon: 'pencil' },
  { command: 'bases:new', icon: 'table' },
  { command: 'marp:new', icon: 'slides' },
  // on by default; a profile can turn applications off (features.web_viewer)
  { command: 'app:new', icon: 'webapp', flag: Feature.WebViewer },
  { command: 'separator:insert', icon: 'separator', gap: true },
  { command: 'graph:open-3d', icon: 'cube', gap: true },
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
  const features = useManaged((s) => s.features);
  // The terminal button is pressed while a terminal is open, docked or in its own window.
  const terminalPressed = useTerminal(terminalOpen);
  useTerminal((s) => s.role);
  const terminal = commandById.get('terminal:toggle');
  const terminalTitle = t('terminal.title');
  // Why it is off, said in the tooltip: a vault the user may only read does not open a shell.
  const terminalWhy =
    terminal && isAvailable(terminal) && !isEnabled(terminal) && readOnlyVault()
      ? `${terminalTitle}: ${t('terminal.readOnlyVault')}`
      : terminalTitle;
  const exports = activePath ? (EXPORTS[classify(activePath)] ?? []) : [];
  const shown = ITEMS.filter((i) => !i.flag || featureOn(features, i.flag));
  const items = exports.length
    ? [...shown, ...exports.map((x, i) => (i ? x : { ...x, gap: true }))]
    : shown;
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
        {terminal && isAvailable(terminal) && (
          <button
            className="icon"
            title={terminalWhy}
            aria-label={terminalWhy}
            aria-pressed={terminalPressed}
            disabled={!isEnabled(terminal)}
            onClick={() => void runCommand('terminal:toggle')}
          >
            <Icon name="terminal" />
          </button>
        )}
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
