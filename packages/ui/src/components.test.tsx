import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog, QuotaBar, quotaLevel, quotaPercent } from './index';

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

  it('keeps Tab inside the dialog', () => {
    render(
      <Dialog title="T" onClose={() => {}} actions={<button>Last</button>}>
        <input aria-label="first" />
      </Dialog>,
    );
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(screen.getByLabelText('first')).toHaveFocus();
  });
});
