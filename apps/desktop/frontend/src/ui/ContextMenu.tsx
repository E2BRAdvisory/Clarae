import { useEffect, useRef, useState } from 'react';

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

/** A small context menu positioned at the pointer; closes on outside click or Escape. */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({
        x: Math.min(x, window.innerWidth - r.width - 4),
        y: Math.min(y, window.innerHeight - r.height - 4),
      });
    }
    const close = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', onClose);
    };
  }, [x, y, onClose]);

  // Keyboard: the menu takes focus when it opens and gives it back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []),
    ];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      buttons[next]?.focus();
    }
  };

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
