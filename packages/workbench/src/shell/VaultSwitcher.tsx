import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openVaultAt } from '../app/actions';
import { runCommand } from '../commands/registry';
import { useCan } from '../platform';
import { useRecentVaults, useTree } from '../state/queries';
import { useAppStore } from '../state/store';
import { infoOf, useSync } from '../state/sync';
import { useAction } from '../ui/ActionButton';
import { ContextMenu, type MenuItem } from '../ui/ContextMenu';

/**
 * Bottom of the left sidebar: the name of the open vault and how many notes it has. Opens a menu
 * with the recent vaults, to switch without going through the welcome screen.
 */
export function VaultSwitcher({ vaultId }: { vaultId: string }) {
  const { t } = useTranslation();
  const vault = useAppStore((s) => s.vault);
  const asked = useAppStore((s) => s.vaultMenuOpen);
  const info = useSync((s) => infoOf(s, vaultId));
  const { data: tree = [] } = useTree(vaultId);
  const { data: recent = [] } = useRecentVaults();
  const multiVault = useCan('multiVault');
  // Where a folder of the computer can be a vault (vault:open-folder).
  const openFolder = useAction('vault:open-folder', openVaultAt);
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const notes = tree.filter((e) => !e.isDir && /\.md$/i.test(e.path)).length;

  const show = (): void => {
    const r = button.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.top });
  };

  // `vault:switch` (palette) asks for the menu to open.
  useEffect(() => {
    if (!asked) return;
    useAppStore.getState().setVaultMenuOpen(false);
    const r = button.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.top });
  }, [asked]);

  if (!vault) return null;

  const items: MenuItem[] = [
    { label: `✓ ${vault.name}`, disabled: true, onSelect: () => undefined },
    ...(multiVault ? recent : [])
      .filter((v) => v.path !== vault.path)
      .slice(0, 8)
      .map((v) => ({ label: v.name, onSelect: () => void openVaultAt(v.path) })),
    ...(openFolder
      ? [{ label: t('vaultSwitcher.open'), separator: true, onSelect: () => void openFolder.run() }]
      : []),
    { label: t('sidebar.closeVault'), onSelect: () => void runCommand('vault:close') },
  ];

  const kind = info.linked ? (info.kind === 'private' ? 'private' : 'shared') : null;
  const count = t('vaultSwitcher.notes', { count: notes });
  return (
    <div className="vault-switcher">
      <button
        ref={button}
        type="button"
        className="vault-switch"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={`${t('vaultSwitcher.label')}: ${vault.name} (${count})`}
        title={vault.path}
        onClick={show}
      >
        <span className="name">{vault.name}</span>
        {kind && <span className={`badge ${kind}`}>{t(`vaultSwitcher.${kind}`)}</span>}
        <span className="count">{count}</span>
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}
