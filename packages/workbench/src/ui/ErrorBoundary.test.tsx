import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Suspense, type ComponentType } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { initI18n } from '../i18n';
import { ErrorBoundary } from './ErrorBoundary';
import { importWithRetry, isChunkLoadError, lazyView } from './lazyView';

const chunkError = () =>
  new TypeError('Failed to fetch dynamically imported module: http://x/assets/chunk-ABC.js');

function Fine({ label }: { label: string }) {
  return <p>{label}</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    initI18n('en');
    // React reports every caught render error on the console: keep the test output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps a failing view inside its own boundary and recovers on retry', () => {
    let broken = true;
    function Fragile() {
      if (broken) throw new Error('render failed');
      return <p>recovered</p>;
    }
    render(
      <>
        <ErrorBoundary scope="view">
          <Fragile />
        </ErrorBoundary>
        <ErrorBoundary scope="view">
          <Fine label="the other pane" />
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByText('This view could not be displayed.')).toBeInTheDocument();
    expect(screen.getByText('render failed')).toBeInTheDocument();
    expect(screen.getByText('the other pane')).toBeInTheDocument();
    // A plain render error offers no page reload, only a retry.
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('starts over when its reset key changes', () => {
    function Boom({ path }: { path: string }) {
      if (path === 'bad.md') throw new Error('bad file');
      return <p>{path}</p>;
    }
    const { rerender } = render(
      <ErrorBoundary scope="view" resetKey="bad.md">
        <Boom path="bad.md" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('bad file')).toBeInTheDocument();
    rerender(
      <ErrorBoundary scope="view" resetKey="good.md">
        <Boom path="good.md" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('good.md')).toBeInTheDocument();
  });

  it('offers a reload at the shell level', () => {
    function Crash(): never {
      throw new Error('shell failed');
    }
    render(
      <ErrorBoundary scope="shell">
        <Crash />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong and the app stopped.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a failed dialog as a modal that can be closed', () => {
    function BrokenDialog(): never {
      throw new Error('dialog failed');
    }
    const onClose = vi.fn();
    render(
      <ErrorBoundary scope="dialog" onClose={onClose}>
        <BrokenDialog />
      </ErrorBoundary>,
    );
    const modal = screen.getByRole('alertdialog', { name: 'This view could not be displayed.' });
    expect(modal).toHaveAttribute('aria-modal', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('lazyView', () => {
  beforeEach(() => {
    initI18n('en');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const mount = (View: ComponentType<{ label: string }>) =>
    render(
      <ErrorBoundary scope="view">
        <Suspense fallback={<p>loading</p>}>
          <View label="drawing editor" />
        </Suspense>
      </ErrorBoundary>,
    );

  it('recognises the errors of a chunk that could not be downloaded', () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
    expect(isChunkLoadError(new Error('x is not a function'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('retries a failed download once, but not other errors', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(chunkError()).mockResolvedValue('ok');
    await expect(importWithRetry(flaky, 0)).resolves.toBe('ok');
    expect(flaky).toHaveBeenCalledTimes(2);
    const broken = vi.fn().mockRejectedValue(new Error('syntax error'));
    await expect(importWithRetry(broken, 0)).rejects.toThrow('syntax error');
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it('shows the view after one failed download', async () => {
    const load = vi.fn().mockRejectedValueOnce(chunkError()).mockResolvedValue({ default: Fine });
    mount(lazyView(load));
    expect(await screen.findByText('drawing editor', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('asks again for a chunk that failed twice when the user retries', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(chunkError())
      .mockRejectedValueOnce(chunkError())
      .mockResolvedValue({ default: Fine });
    mount(lazyView(load));
    expect(
      await screen.findByText('This view could not be downloaded.', {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // React.lazy alone would rethrow the cached failure forever.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('drawing editor')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(3);
  });
});
