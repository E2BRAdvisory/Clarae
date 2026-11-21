import { useRef } from 'react';
import { isGraphPath } from '../graph/paths';
import { usePresenceEnabled, usePresenceWatch } from '../presence/watch';
import { useAppStore } from '../state/store';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { EmptyPane } from './EmptyPane';
import type { LayoutNode, Pane } from './layout';
import { NoteView } from './NoteView';
import { TabBar } from './TabBar';

function PaneView({ vaultId, pane }: { vaultId: string; pane: Pane }) {
  const activePane = useAppStore((s) => s.layout.activePane);
  const focusPane = useAppStore((s) => s.focusPane);
  const tab = pane.tabs.find((x) => x.id === pane.active);
  // The tab in front of each pane is watched for the people who have the same file open (ADR-0065): the
  // core counts the watches, so the same file in two panes is two of them.
  const presence = usePresenceEnabled(vaultId);
  usePresenceWatch(vaultId, tab && !isGraphPath(tab.path) ? tab.path : null, presence);
  return (
    <div
      className={`pane ${activePane === pane.id ? 'focused' : ''}`}
      onMouseDown={() => focusPane(pane.id)}
      data-pane={pane.id}
    >
      {pane.tabs.length > 0 && <TabBar pane={pane} />}
      <div className="pane-body">
        {tab ? (
          // A view that fails stays inside its pane; another file in the tab starts over.
          <ErrorBoundary scope="view" resetKey={`${tab.id}:${tab.path}`}>
            <NoteView
              key={`${pane.id}:${tab.id}`}
              vaultId={vaultId}
              pane={pane}
              tab={tab}
              visible
            />
          </ErrorBoundary>
        ) : (
          <EmptyPane paneId={pane.id} />
        )}
      </div>
    </div>
  );
}

function Resizer({
  index,
  dir,
  container,
  sizes,
  id,
}: {
  index: number;
  dir: 'row' | 'column';
  container: React.RefObject<HTMLDivElement | null>;
  sizes: number[];
  id: string;
}) {
  const resizeSplit = useAppStore((s) => s.resizeSplit);
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = container.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const total = dir === 'row' ? rect.width : rect.height;
    const start = dir === 'row' ? e.clientX : e.clientY;
    const initial = [...sizes];
    const move = (ev: PointerEvent): void => {
      const delta = ((dir === 'row' ? ev.clientX : ev.clientY) - start) / total;
      const pair = (initial[index] ?? 0) + (initial[index + 1] ?? 0);
      const a = Math.min(pair - 0.08, Math.max(0.08, (initial[index] ?? 0) + delta));
      const next = [...initial];
      next[index] = a;
      next[index + 1] = pair - a;
      resizeSplit(id, next);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      className={`resizer ${dir}`}
      role="separator"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={onDown}
    />
  );
}

function Node({ vaultId, node }: { vaultId: string; node: LayoutNode }) {
  const ref = useRef<HTMLDivElement>(null);
  if (node.kind === 'pane') return <PaneView vaultId={vaultId} pane={node} />;
  return (
    <div className={`split ${node.dir}`} ref={ref}>
      {node.children.map((child, i) => (
        <div key={child.id} className="split-child" style={{ flex: `${node.sizes[i] ?? 1} 1 0` }}>
          <Node vaultId={vaultId} node={child} />
          {i < node.children.length - 1 && (
            <Resizer index={i} dir={node.dir} container={ref} sizes={node.sizes} id={node.id} />
          )}
        </div>
      ))}
    </div>
  );
}

export function WorkspaceView({ vaultId }: { vaultId: string }) {
  const root = useAppStore((s) => s.layout.root);
  return (
    <div className="workspace">
      <Node vaultId={vaultId} node={root} />
    </div>
  );
}
