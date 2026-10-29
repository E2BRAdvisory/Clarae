import { useAppStore } from '../state/store';

export function SidebarResizer({ side }: { side: 'left' | 'right' }) {
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const st = useAppStore.getState();
    const start = e.clientX;
    const initial = side === 'left' ? st.left.width : st.right.width;
    const move = (ev: PointerEvent): void => {
      const delta = side === 'left' ? ev.clientX - start : start - ev.clientX;
      const width = Math.min(600, Math.max(180, initial + delta));
      if (side === 'left') useAppStore.getState().setLeft({ width });
      else useAppStore.getState().setRight({ width });
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
      className={`sidebar-resizer ${side}`}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onDown}
    />
  );
}
