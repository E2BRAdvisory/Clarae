import { useEffect, useRef, useState } from 'react';
import { useMenuKeyboard } from '@clarae/ui';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** A thin divider is drawn before this item. */
  separator?: boolean;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * A small context menu positioned at the pointer. Keyboard and dismissal (arrows, Home/End, Escape,
 * Tab, outside press, focus in and back) come from useMenuKeyboard of @clarae/ui.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const { onKeyDown } = useMenuKeyboard(ref, onClose);

  // Kept inside the window.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 4),
      y: Math.min(y, window.innerHeight - r.height - 4),
    });
  }, [x, y]);

  return (
    <div
      className="context-menu"
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onKeyDown={onKeyDown}
    >
      {items.map((it, i) => (
        <div key={i} role="none">
          {it.separator && <div className="separator" role="separator" />}
          <button
            role="menuitem"
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>
  );
}
