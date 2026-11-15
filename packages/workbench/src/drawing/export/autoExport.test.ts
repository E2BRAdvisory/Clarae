import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_EXPORT_QUIET_MS, createAutoExporter } from './autoExport';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (ok: () => boolean = () => true) => {
  const runs: string[] = [];
  const exporter = createAutoExporter<string>((job) => {
    runs.push(job);
    return Promise.resolve(ok());
  });
  return { exporter, runs };
};
const pause = (ms = AUTO_EXPORT_QUIET_MS) => vi.advanceTimersByTimeAsync(ms);

describe('the automatic export of a drawing', () => {
  it('waits for a pause in the saves, and exports the last one', async () => {
    const { exporter, runs } = setup();
    exporter.saved('v1', 'one');
    await pause(AUTO_EXPORT_QUIET_MS - 1);
    exporter.saved('v2', 'two'); // still at work: the wait starts over
    await pause(AUTO_EXPORT_QUIET_MS - 1);
    expect(runs).toEqual([]);
    expect(exporter.waiting()).toBe(true);
    await pause(1);
    expect(runs).toEqual(['two']);
    expect(exporter.waiting()).toBe(false);
  });

  it('does not export again what the files already show', async () => {
    const { exporter, runs } = setup();
    exporter.saved('v1', 'one');
    await pause();
    exporter.saved('v1', 'one again'); // saved again without a change to what is drawn
    await pause();
    expect(runs).toEqual(['one']);
    // a change and back (an undo): nothing to export either
    exporter.saved('v2', 'two');
    exporter.saved('v1', 'back');
    await pause();
    expect(runs).toEqual(['one']);
  });

  it('exports at once when asked (the drawing closes)', async () => {
    const { exporter, runs } = setup();
    exporter.saved('v1', 'one');
    await exporter.flush();
    expect(runs).toEqual(['one']);
    // the timer of that save is gone with it
    await pause();
    expect(runs).toEqual(['one']);
    // nothing waiting: nothing done
    await exporter.flush();
    expect(runs).toEqual(['one']);
  });

  it('tries again at the next save when an export failed', async () => {
    let ok = false;
    const { exporter, runs } = setup(() => ok);
    exporter.saved('v1', 'one');
    await pause();
    ok = true;
    exporter.saved('v1', 'one');
    await pause();
    expect(runs).toEqual(['one', 'one']);
    exporter.saved('v1', 'one');
    await pause();
    expect(runs).toEqual(['one', 'one']);
  });

  it('counts an export that throws as failed', async () => {
    const run = vi.fn<(job: string) => Promise<boolean>>().mockRejectedValueOnce(new Error('disk'));
    run.mockResolvedValue(true);
    const exporter = createAutoExporter(run);
    exporter.saved('v1', 'one');
    await pause();
    exporter.saved('v1', 'one');
    await pause();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs one export at a time, in order', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const exporter = createAutoExporter<string>(async (job) => {
      order.push(`start ${job}`);
      if (job === 'one') await new Promise<void>((resolve) => (release = resolve));
      order.push(`end ${job}`);
      return true;
    });
    exporter.saved('v1', 'one');
    const first = exporter.flush();
    exporter.saved('v2', 'two');
    const second = exporter.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['start one']);
    release?.();
    await Promise.all([first, second]);
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two']);
  });

  it('forgets what was waiting when the export is turned off', async () => {
    const { exporter, runs } = setup();
    exporter.saved('v1', 'one');
    exporter.cancel();
    await pause();
    await exporter.flush();
    expect(runs).toEqual([]);
  });
});
