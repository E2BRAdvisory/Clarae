import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog, QuotaBar, hasModalFocus, quotaLevel, quotaPercent } from './index';

afterEach(cleanup);

describe('quota levels', () => {
  it.each([
    [0, 100, 'ok'],
    [79, 100, 'ok'],
    [80, 100, 'warn'],
    [94, 100, 'warn'],
    [95, 100, 'critical'],
    [99, 100, 'critical'],
    [100, 100, 'full'],
    [150, 100, 'full'],
    [123456, -1, 'ok'],
    [5, 0, 'ok'],
  ])('used %d of %d is %s', (used, quota, level) => {
    expect(quotaLevel(used, quota)).toBe(level);
  });

  it('clamps the percentage', () => {
    expect(quotaPercent(150, 100)).toBe(100);
    expect(quotaPercent(1, -1)).toBe(0);
  });
});

describe('QuotaBar', () => {
  it('exposes the level and an accessible progress value', () => {
    render(<QuotaBar usedBytes={96} quotaBytes={100} label="Storage" caption="96 of 100" />);
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-level', 'critical');
    const bar = screen.getByRole('progressbar', { name: 'Storage' });
    expect(bar).toHaveAttribute('value', '96');
  });

  it('shows an empty bar for unlimited quotas', () => {
    render(<QuotaBar usedBytes={5} quotaBytes={-1} label="Storage" caption="5" />);
    expect(screen.getByTestId('quota-bar')).toHaveAttribute('data-level', 'ok');
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '0');
  });
});

describe('Dialog', () => {
  it('is labelled, focuses its first control and closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Dialog title="Revoke?" onClose={onClose} actions={<button>OK</button>}>
        <input aria-label="name" />
      </Dialog>,
    );
    const dlg = screen.getByRole('dialog', { name: 'Revoke?' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('name')).toHaveFocus();
    fireEvent.keyDown(dlg, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  describe('with the document focus handler', () => {
    // jsdom has no layout: pretend every control is rendered (focus.ts skips invisible ones).
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
        {} as DOMRect,
      ] as unknown as DOMRectList);
    });
    afterEach(() => vi.restoreAllMocks());

    it('keeps Tab inside the dialog through the one handler of the page', () => {
      render(
        <Dialog title="T" onClose={() => {}} actions={<button>Last</button>}>
          <input aria-label="first" />
        </Dialog>,
      );
      expect(hasModalFocus()).toBe(true);
      const last = screen.getByRole('button', { name: 'Last' });
      last.focus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(screen.getByLabelText('first')).toHaveFocus();
    });

    it('gives the focus back to the opener when it closes', async () => {
      function Host() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button onClick={() => setOpen(true)}>Open</button>
            {open && (
              <Dialog title="T" onClose={() => setOpen(false)}>
                <input aria-label="name" />
              </Dialog>
            )}
          </>
        );
      }
      render(<Host />);
      const opener = screen.getByRole('button', { name: 'Open' });
      opener.focus();
      fireEvent.click(opener);
      expect(screen.getByLabelText('name')).toHaveFocus();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(opener).toHaveFocus();
    });
  });

  it('leaves the focus to a control that took it, and lets the host handle keys first', () => {
    const onClose = vi.fn();
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => {
      if (e.key === 'Enter') e.preventDefault();
    });
    render(
      <Dialog title="Sure?" onClose={onClose} onKeyDown={onKeyDown} closeOnBackdrop>
        <button>Cancel</button>
        <button autoFocus>OK</button>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus();
    const dlg = screen.getByRole('dialog', { name: 'Sure?' });
    fireEvent.keyDown(dlg, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dlg);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dlg.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('takes the host classes instead of the nd-* ones', () => {
    render(
      <Dialog
        title="T"
        onClose={() => {}}
        classNames={{ backdrop: 'modal-backdrop', dialog: 'modal dialog' }}
      >
        <p>Body</p>
      </Dialog>,
    );
    const dlg = screen.getByRole('dialog');
    expect(dlg).toHaveClass('modal', 'dialog');
    expect(dlg).not.toHaveClass('nd-dialog');
    expect(dlg.parentElement).toHaveClass('modal-backdrop');
  });
});
