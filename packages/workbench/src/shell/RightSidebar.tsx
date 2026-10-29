import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { LinksPanel } from '../sidebar/LinksPanel';
import { PropertiesPanel } from '../sidebar/PropertiesPanel';
import { SlidesPanel } from '../sidebar/SlidesPanel';
import { StatsPanel } from '../sidebar/StatsPanel';
import { TagsPanel } from '../sidebar/TagsPanel';
import { SidebarResizer } from './SidebarResizer';
import { SidebarTabs } from './SidebarTabs';
import { VaultStatus } from './VaultStatus';
import { RIGHT_TABS, RIGHT_TAB_ICONS } from './tabs';

export function RightSidebar({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const right = useAppStore((s) => s.right);
  const setRight = useAppStore((s) => s.setRight);
  return (
    <aside className="sidebar right" aria-label={t('sidebar.right')}>
      <SidebarTabs
        tabs={RIGHT_TABS}
        value={right.tab}
        onChange={(tab) => setRight({ tab })}
        label={(tab) => t(`sidebar.${tab}`)}
        icon={(tab) => RIGHT_TAB_ICONS[tab]}
      />
      {right.tab === 'properties' && <PropertiesPanel vaultId={vaultId} />}
      {right.tab === 'tags' && <TagsPanel vaultId={vaultId} />}
      {right.tab === 'links' && <LinksPanel vaultId={vaultId} />}
      {right.tab === 'slides' && <SlidesPanel vaultId={vaultId} />}
      {right.tab === 'stats' && <StatsPanel vaultId={vaultId} />}
      <footer className="sidebar-footer">
        <VaultStatus />
      </footer>
      <SidebarResizer side="right" />
    </aside>
  );
}
