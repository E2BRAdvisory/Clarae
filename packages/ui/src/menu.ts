// Keyboard and dismissal behaviour of a menu (ARIA menu pattern), shared by the workbench's context
// menus and any console menu (ADR-0043): the first enabled item takes focus when the menu opens and
// the opener gets it back when it closes; arrows move between items (wrapping), Home/End jump to the
// ends, Escape, Tab, a press outside the menu or the window losing focus close it.
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

const ITEM = '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])';

export interface MenuKeyboardOptions {
  /** Selector of the focusable items (default: enabled `[role="menuitem"]`). */
  itemSelector?: string;
}

/**
 * Wires a menu element (`ref`, with role="menu") to the keyboard; returns the `onKeyDown` handler to
 * put on it. `onClose` may change between renders.
 */
export function useMenuKeyboard(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  opts: MenuKeyboardOptions = {},
): { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void } {
  const selector = opts.itemSelector ?? ITEM;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Dismissal: Escape anywhere, a press outside the menu, the window losing focus.
  useEffect(() => {
    const close = (e: Event): void => {
      if (e instanceof globalThis.KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    const blur = (): void => onCloseRef.current();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('blur', blur);
    };
  }, [ref]);

  // Focus moves in when the menu opens and back to the opener when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(selector)?.focus();
    return () => opener?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(selector) ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Tab') {
      e.preventDefault();
      onCloseRef.current();
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      items[next]?.focus();
    }
  };

  return { onKeyDown };
}
