import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Feature } from '@clarae/api-client/features';
import { formatCombo, isMac } from '../commands/hotkeys';
import {
  commandById,
  commandTitle,
  currentCombos,
  isAvailable,
  isEnabled,
  runCommand,
} from '../commands/registry';
import { ariaCombo } from '../editor/live/chrome/shortcuts';
import { Icon, type IconName } from '../shell/icons';
import { featureOn, useManaged } from '../state/managed';
import { useSettings } from '../state/settings';
import { useAppStore } from '../state/store';
import { useSync } from '../state/sync';

type Item = { command: string; icon: IconName; flag?: Feature; gap?: boolean };

/** What a pane with nothing open offers, top to bottom. Each one is a registry command. */
const ITEMS: Item[] = [
  { command: 'note:new', icon: 'filePlus' },
  { command: 'canvas:new', icon: 'canvas', flag: Feature.Canvas },
  { command: 'drawing:new', icon: 'pencil', flag: Feature.Drawings },
  { command: 'marp:new', icon: 'slides', flag: Feature.Presentations },
  { command: 'app:new', icon: 'webapp', flag: Feature.WebViewer },
  { command: 'switcher:open', icon: 'search', gap: true },
];

/** The body of a pane without tabs: the commands that put something in it. */
export function EmptyPane({ paneId }: { paneId: string }) {
  const { t } = useTranslation();
  const focusPane = useAppStore((s) => s.focusPane);
  // Whether a command is enabled depends on these; subscribing re-evaluates it on change.
  useAppStore((s) => s.vault);
  useSync((s) => s);
  const features = useManaged((s) => s.features);
  const overrides = useSettings((s) => s.hotkeys);
  const combos = useMemo(() => currentCombos(overrides), [overrides]);
  const mac = isMac();

  // A function the host or the profile does not offer is not shown; one that cannot run now
  // (a vault that may not be changed) stays, disabled.
  const items = ITEMS.filter(({ command, flag }) => {
    const c = commandById.get(command);
    return !!c && isAvailable(c) && (!flag || featureOn(features, flag));
  });

  return (
    <div className="empty-pane" role="group" aria-label={t('editor.emptyActions')}>
      <p>{t('editor.empty')}</p>
      <ul>
        {items.map(({ command, icon, gap }) => {
          const combo = combos.get(command)?.[0];
          return (
            <li key={command} className={gap ? 'gap' : undefined}>
              <button
                type="button"
                disabled={!isEnabled(commandById.get(command)!)}
                {...(combo ? { 'aria-keyshortcuts': ariaCombo(combo, mac) } : {})}
                onClick={() => {
                  // A click focuses the pane on its way here; the keyboard does not.
                  focusPane(paneId);
                  void runCommand(command);
                }}
              >
                <Icon name={icon} size={18} />
                <span className="label">{commandTitle(command)}</span>
                {combo && <kbd aria-hidden="true">{formatCombo(combo, mac)}</kbd>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
