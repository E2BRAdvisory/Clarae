import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../app/api';
import { onVaultChanges, type VaultChangeBatch } from '../app/fileChanges';
import { dialog } from '../ui/dialogs';
import { viewIndexByName } from './model';
import type { BaseInfo, BaseResult, ViewPatch } from './types';
import { errorMessage } from '../util/errors';

interface Options {
  vaultId: string;
  path: string;
  /** The note containing the base ("this" in expressions); the base itself when opened directly. */
  thisPath: string;
  /** Initial view by name (embeds: `![[x.base#View]]`). */
  viewName?: string;
  /** Embeds return false once their host element left the document, which stops the refresh. */
  isAlive?: () => boolean;
  onDetached?: () => void;
}

export interface BaseState {
  info: BaseInfo | null;
  result: BaseResult | null;
  viewIndex: number;
  error: string;
  loading: boolean;
  selectView: (i: number) => void;
  patchView: (patch: ViewPatch) => Promise<void>;
  setCell: (rowPath: string, key: string, hash: string, value: unknown) => Promise<void>;
  reload: () => void;
}

const message = (e: unknown): string => errorMessage(e);

/** Quiet time after the last vault change before the base runs again. */
export const REFRESH_MS = 300;

const isConfig = (path: string): boolean => path === '.clarae' || path.startsWith('.clarae/');

/**
 * Whether a batch of file changes can change a base's result. Any file of the vault can be a row
 * (file.* properties, attachments included) and any note's properties can match its filters,
 * the containing note's own ("this") among them; only the app's settings under .clarae/ cannot.
 */
export function baseNeedsRefresh(batch: VaultChangeBatch): boolean {
  return batch.unknown || batch.changes.some((c) => !isConfig(c.path));
}

/** The previous value when the new one has the same content: the table is not redrawn. */
function same<T>(prev: T | null, next: T): T {
  return prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

/** Loads a .base file and the result of one of its views; refreshes when the vault changes. */
export function useBase(o: Options): BaseState {
  const { vaultId, path, thisPath, viewName, isAlive, onDetached } = o;
  const [info, setInfo] = useState<BaseInfo | null>(null);
  const [result, setResult] = useState<BaseResult | null>(null);
  const [viewIndex, setViewIndex] = useState(-1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const viewRef = useRef(-1);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const bi = await api.bases.load(vaultId, path);
      if (my !== seq.current) return;
      setInfo((prev) => same(prev, bi));
      if (bi.parseError) {
        setResult(null);
        setError(bi.parseError);
        return;
      }
      const idx =
        viewRef.current >= 0 && viewRef.current < bi.views.length
          ? viewRef.current
          : viewIndexByName(bi, viewName ?? '');
      if (bi.views.length === 0) {
        setResult(null);
        setError('');
        return;
      }
      const res = await api.bases.run(vaultId, path, idx, thisPath);
      if (my !== seq.current) return;
      viewRef.current = idx;
      setViewIndex(idx);
      setResult((prev) => same(prev, res));
      setError('');
    } catch (e) {
      if (my === seq.current) setError(message(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [vaultId, path, thisPath, viewName]);

  useEffect(() => {
    viewRef.current = -1;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Results of a load that started before the hook unmounted are dropped.
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );

  // Refreshes after vault changes: bursts are coalesced, and while a run is in flight (it may take
  // seconds on a large vault) the next one waits for it instead of piling up on the core.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    let stopped = false;
    const refresh = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await loadRef.current();
      } finally {
        running = false;
      }
      if (again && !stopped) {
        again = false;
        void refresh();
      }
    };
    const off = onVaultChanges((batch) => {
      if (batch.vaultId !== vaultId || !baseNeedsRefresh(batch)) return;
      if (isAlive && !isAlive()) {
        onDetached?.();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_MS);
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      off();
    };
  }, [vaultId, isAlive, onDetached]);

  const selectView = useCallback(
    (i: number) => {
      viewRef.current = i;
      setViewIndex(i);
      void load();
    },
    [load],
  );

  const patchView = useCallback(
    async (patch: ViewPatch) => {
      if (!info) return;
      try {
        await api.bases.updateView(vaultId, path, Math.max(0, viewRef.current), patch, info.hash);
      } catch (e) {
        await dialog.error(e);
      }
      await load();
    },
    [info, vaultId, path, load],
  );

  const setCell = useCallback(
    async (rowPath: string, key: string, hash: string, value: unknown) => {
      try {
        await api.bases.updateProperty(vaultId, rowPath, key, value, hash);
      } catch (e) {
        await dialog.error(e);
      }
      await load();
    },
    [vaultId, load],
  );

  return {
    info,
    result,
    viewIndex,
    error,
    loading,
    selectView,
    patchView,
    setCell,
    reload: () => void load(),
  };
}
