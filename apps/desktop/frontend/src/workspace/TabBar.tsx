import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';
import type { Pane } from './layout';

const label = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/, '');

export function TabBar({ pane }: { pane: Pane }) {
  const { t } = useTranslation();
  const activateTab = useAppStore((s) => s.activateTab);
  const focusPane = useAppStore((s) => s.focusPane);
  const closeTabById = useAppStore((s) => s.closeTabById);
  const moveTabTo = useAppStore((s) => s.moveTabTo);
  const split = useAppStore((s) => s.split);
  const toggleLinkedPane = useAppStore((s) => s.toggleLinkedPane);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [over, setOver] = useState<number | null>(null);

  return (
    <div
      className="tabbar"
      role="tablist"
      onMouseDown={() => focusPane(pane.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-nodus-tab')) e.preventDefault();
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('application/x-nodus-tab');
        if (id) moveTabTo(id, pane.id);
        setOver(null);
      }}
    >
      {pane.tabs.map((tab, i) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={pane.active === tab.id}
          className={`tab ${pane.active === tab.id ? 'active' : ''} ${over === i ? 'over' : ''}`}
          draggable
          title={tab.path}
          onDragStart={(e) => e.dataTransfer.setData('application/x-nodus-tab', tab.id)}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('application/x-nodus-tab')) return;
            e.preventDefault();
            e.stopPropagation();
            setOver(i);
          }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            const id = e.dataTransfer.getData('application/x-nodus-tab');
            e.stopPropagation();
            setOver(null);
            if (id) moveTabTo(id, pane.id, i);
          }}
          onClick={() => activateTab(pane.id, tab.id)}
          onAuxClick={(e) => e.button === 1 && closeTabById(tab.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            activateTab(pane.id, tab.id);
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: t('tabs.close'), onSelect: () => closeTabById(tab.id) },
                {
                  label: t('tabs.closeOthers'),
                  onSelect: () =>
                    pane.tabs.filter((x) => x.id !== tab.id).forEach((x) => closeTabById(x.id)),
                },
                { label: t('tabs.splitRight'), onSelect: () => split('row'), separator: true },
                { label: t('tabs.splitDown'), onSelect: () => split('column') },
                {
                  label: pane.link ? t('tabs.unlink') : t('tabs.link'),
                  onSelect: () => toggleLinkedPane(pane.id),
                },
              ],
            });
          }}
        >
          <span className="tab-title">{label(tab.path)}</span>
          <button
            className="icon close"
            aria-label={t('tabs.close')}
            onClick={(e) => {
              e.stopPropagation();
              closeTabById(tab.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <span className="spacer" />
      {pane.link && (
        <button
          className="icon"
          title={t('tabs.unlink')}
          aria-label={t('tabs.unlink')}
          onClick={() => toggleLinkedPane(pane.id)}
        >
          🔗
        </button>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
