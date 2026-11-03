import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { initI18n } from '../i18n';
import { LazyDialog } from './LazyDialog';
import { lazyView } from './lazyView';

const chunkError = () =>
  new TypeError('Failed to fetch dynamically imported module: http://x/assets/Settings-ABC.js');

function Settings() {
  return <div role="dialog" aria-label="Settings" />;
}

describe('LazyDialog', () => {
  beforeEach(() => {
    initI18n('en');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows the dialog once its chunk arrives', async () => {
    const View = lazyView(() => Promise.resolve({ default: Settings }));
    render(
      <LazyDialog onClose={() => {}}>
        <View />
      </LazyDialog>,
    );
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('replaces a dialog that cannot be downloaded with a modal that offers a retry and Close', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(chunkError())
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValue({ default: Settings });
    const View = lazyView(load);
    const onClose = vi.fn();
    render(
      <>
        <p>workbench</p>
        <LazyDialog onClose={onClose}>
          <View />
        </LazyDialog>
      </>,
    );
    const modal = await screen.findByRole(
      'alertdialog',
      { name: 'This view could not be downloaded.' },
      { timeout: 2000 },
    );
    expect(modal).toHaveAttribute('aria-modal', 'true');
    // The rest of the workbench stays.
    expect(screen.getByText('workbench')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(3);
  });
});
