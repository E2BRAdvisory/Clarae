import { useTranslation } from 'react-i18next';
import { useAppStore } from '../state/store';
import { FileExplorer } from '../sidebar/FileExplorer';
import { OutlinePanel } from '../sidebar/OutlinePanel';
import { SearchPanel } from '../search/SearchPanel';
import { SidebarResizer } from './SidebarResizer';
import { SidebarTabs } from './SidebarTabs';
import { VaultSwitcher } from './VaultSwitcher';
import { leftTabs } from './tabs';

export function LeftSidebar({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const left = useAppStore((s) => s.left);
  const setLeft = useAppStore((s) => s.setLeft);
  return (
    <aside className="sidebar left" aria-label={t('sidebar.left')}>
      <SidebarTabs
        tabs={leftTabs(left.tab)}
        value={left.tab}
        onChange={(tab) => setLeft({ tab })}
        label={(tab) => t(`sidebar.${tab}`)}
      />
      {left.tab === 'files' && <FileExplorer vaultId={vaultId} />}
      {left.tab === 'outline' && <OutlinePanel vaultId={vaultId} />}
      {left.tab === 'search' && <SearchPanel vaultId={vaultId} />}
      <footer className="sidebar-footer">
        <VaultSwitcher vaultId={vaultId} />
      </footer>
      <SidebarResizer side="left" />
    </aside>
  );
}
