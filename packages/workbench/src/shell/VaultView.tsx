import { useAppStore } from '../state/store';
import { WorkspaceView } from '../workspace/WorkspaceView';
import { ChatBar } from './ChatBar';
import { LeftSidebar } from './LeftSidebar';
import { Ribbon } from './Ribbon';
import { RightSidebar } from './RightSidebar';
import { useVaultSession } from './useVaultSession';

export function VaultView({ vaultId }: { vaultId: string }) {
  useVaultSession(vaultId);
  const left = useAppStore((s) => s.left);
  const right = useAppStore((s) => s.right);

  return (
    <div
      className="vault"
      style={{
        gridTemplateColumns: `var(--ribbon-width) ${left.open ? left.width : 0}px 1fr ${right.open ? right.width : 0}px`,
      }}
    >
      <Ribbon />
      {left.open ? <LeftSidebar vaultId={vaultId} /> : <div />}
      <main className="main">
        <WorkspaceView vaultId={vaultId} />
        <ChatBar />
      </main>
      {right.open ? <RightSidebar vaultId={vaultId} /> : <div />}
    </div>
  );
}
