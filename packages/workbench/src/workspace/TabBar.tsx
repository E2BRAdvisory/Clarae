import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { bookmarkMenuItems } from '../bookmarks/actions';
import { useAppStore } from '../state/store';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import { graphTitle, isGraphPath } from '../graph/paths';
import { useRecovery } from '../recovery/store';
import { Icon } from '../shell/icons';
import type { Pane, Tab } from './layout';
import { DRAG_TAB } from '../util/dragTypes';

/** Whether closing would remove at least one of these tabs (locked ones stay). */
const closable = (tabs: Tab[]): boolean => tabs.some((x) => !x.pinned);

const label = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/, '');

export function TabBar({ pane }: { pane: Pane }) {
  const { t } = useTranslation();
  const activateTab = useAppStore((s) => s.activateTab);
  const focusPane = useAppStore((s) => s.focusPane);
  const closeTabById = useAppStore((s) => s.closeTabById);
  const togglePinTab = useAppStore((s) => s.togglePinTab);
  const closeTabsRightOf = useAppStore((s) => s.closeTabsRightOf);
  const closeTabsLeftOf = useAppStore((s) => s.closeTabsLeftOf);
  const closeOtherTabsOf = useAppStore((s) => s.closeOtherTabsOf);
  const closeAllTabsIn = useAppStore((s) => s.closeAllTabsIn);
  const moveTabTo = useAppStore((s) => s.moveTabTo);
  const split = useAppStore((s) => s.split);
  const toggleLinkedPane = useAppStore((s) => s.toggleLinkedPane);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const name = (tab: Tab): string =>
    isGraphPath(tab.path)
      ? t(graphTitle(tab.path).key, { name: graphTitle(tab.path).name })
      : label(tab.path);

  // Roving tabindex: arrows move between tabs (and activate them), Delete closes the tab.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, id: string, i: number) => {
    const n = pane.tabs.length;
    let target = -1;
    if (e.key === 'ArrowRight') target = (i + 1) % n;
    else if (e.key === 'ArrowLeft') target = (i - 1 + n) % n;
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = n - 1;
    else if (e.key === 'Delete') {
      e.preventDefault();
      closeTabById(id);
      return;
    } else return;
    e.preventDefault();
    const next = pane.tabs[target];
    if (!next) return;
    activateTab(pane.id, next.id);
    const buttons = e.currentTarget.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]');
    requestAnimationFrame(() => (buttons?.[target] as HTMLElement | undefined)?.focus());
  };

  return (
    <div
      className="tabbar"
      onMouseDown={() => focusPane(pane.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TAB)) e.preventDefault();
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TAB);
        if (id) moveTabTo(id, pane.id);
        setOver(null);
      }}
    >
      <div role="tablist" className="tablist" aria-label={t('tabs.list')}>
        {pane.tabs.map((tab, i) => (
          <div
            key={tab.id}
            role="presentation"
            className={`tab ${pane.active === tab.id ? 'active' : ''} ${over === i ? 'over' : ''} ${tab.pinned ? 'pinned' : ''}`}
            draggable
            title={tab.path}
            onDragStart={(e) => e.dataTransfer.setData(DRAG_TAB, tab.id)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_TAB)) return;
              e.preventDefault();
              e.stopPropagation();
              setOver(i);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(DRAG_TAB);
              e.stopPropagation();
              setOver(null);
              if (id) moveTabTo(id, pane.id, i);
            }}
            onAuxClick={(e) => e.button === 1 && closeTabById(tab.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              activateTab(pane.id, tab.id);
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  {
                    label: tab.pinned ? t('tabs.unpin') : t('tabs.pin'),
                    onSelect: () => togglePinTab(tab.id),
                  },
                  {
                    label: t('tabs.close'),
                    disabled: !!tab.pinned,
                    onSelect: () => closeTabById(tab.id),
                    separator: true,
                  },
                  {
                    label: t('tabs.closeRight'),
                    disabled: !closable(pane.tabs.slice(i + 1)),
                    onSelect: () => closeTabsRightOf(tab.id),
                  },
                  {
                    label: t('tabs.closeLeft'),
                    disabled: !closable(pane.tabs.slice(0, i)),
                    onSelect: () => closeTabsLeftOf(tab.id),
                  },
                  {
                    label: t('tabs.closeOthers'),
                    disabled: !closable(pane.tabs.filter((x) => x.id !== tab.id)),
                    onSelect: () => closeOtherTabsOf(tab.id),
                  },
                  {
                    label: t('tabs.closeAll'),
                    disabled: !closable(pane.tabs),
                    onSelect: () => closeAllTabsIn(pane.id),
                  },
                  {
                    label: t('commands.recovery_open'),
                    onSelect: () => useRecovery.getState().openNote(tab.path),
                    separator: true,
                  },
                  { label: t('tabs.splitRight'), onSelect: () => split('row') },
                  { label: t('tabs.splitDown'), onSelect: () => split('column') },
                  {
                    label: pane.link ? t('tabs.unlink') : t('tabs.link'),
                    onSelect: () => toggleLinkedPane(pane.id),
                  },
                  ...bookmarkMenuItems(tab.path, false).map((m) => ({ ...m, separator: true })),
                ],
              });
            }}
          >
            <button
              type="button"
              role="tab"
              className="tab-title"
              aria-selected={pane.active === tab.id}
              tabIndex={pane.active === tab.id ? 0 : -1}
              onClick={() => activateTab(pane.id, tab.id)}
              onKeyDown={(e) => onTabKey(e, tab.id, i)}
              {...(tab.pinned ? { 'aria-label': t('tabs.locked', { name: name(tab) }) } : {})}
            >
              {name(tab)}
            </button>
            {tab.pinned ? (
              <button
                className="icon pin"
                tabIndex={-1}
                // A tablist holds only tabs for assistive technology: the lock is announced on the
                // tab itself ("(locked)") and undone from the menu or the `tab:pin` command.
                aria-hidden="true"
                title={t('tabs.unpin')}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePinTab(tab.id);
                }}
              >
                <Icon name="pin" />
              </button>
            ) : (
              <button
                className="icon close"
                tabIndex={-1}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTabById(tab.id);
                }}
              >
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
      <span className="spacer" />
      {pane.link && (
        <button
          className="icon"
          title={t('tabs.unlink')}
          aria-label={t('tabs.unlink')}
          onClick={() => toggleLinkedPane(pane.id)}
        >
          <Icon name="link" />
        </button>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
