import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob, REVOKE_AFTER_MS } from './download';

describe('downloadBlob', () => {
  afterEach(() => vi.useRealTimers());

  it('clicks a hidden anchor and revokes the URL only after the delay', () => {
    vi.useFakeTimers();
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    downloadBlob(new Blob(['a']), 'a.zip');
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('a.zip');
    expect(clicked[0]?.href).toBe('blob:x');
    expect(clicked[0]?.isConnected).toBe(false);
    vi.advanceTimersByTime(REVOKE_AFTER_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    click.mockRestore();
  });
});
