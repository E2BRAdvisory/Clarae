import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMenuKeyboard } from './menu';

afterEach(cleanup);

function Menu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useMenuKeyboard(ref, onClose);
  return (
    <div ref={ref} role="menu" onKeyDown={onKeyDown}>
      <button role="menuitem">One</button>
      <button role="menuitem" disabled>
        Off
      </button>
      <button role="menuitem">Two</button>
      <button role="menuitem">Three</button>
    </div>
  );
}

function Host({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Opener</button>
      <button>Elsewhere</button>
      {open && (
        <Menu
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function openMenu(onClose?: () => void): void {
  render(<Host {...(onClose ? { onClose } : {})} />);
  const opener = screen.getByRole('button', { name: 'Opener' });
  opener.focus();
  fireEvent.click(opener);
}

describe('useMenuKeyboard', () => {
  it('focuses the first item and moves with the arrows, Home and End, skipping disabled items', () => {
    openMenu();
    const item = (name: string) => screen.getByRole('menuitem', { name });
    expect(item('One')).toHaveFocus();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(item('Two')).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(item('Three')).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(item('One')).toHaveFocus(); // wraps
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(item('Three')).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(item('One')).toHaveFocus();
  });

  it('closes on Escape and gives the focus back to the opener', () => {
    const onClose = vi.fn();
    openMenu(onClose);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Opener' })).toHaveFocus();
  });

  it('closes on Tab and on a press outside, not on a press inside', () => {
    const onClose = vi.fn();
    openMenu(onClose);
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Two' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Opener' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
