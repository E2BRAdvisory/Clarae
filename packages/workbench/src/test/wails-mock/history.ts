// HistoryAPI mock: local file snapshots kept in memory; tests seed `snapshots` and read `restored`.
import type { HistoryDeleted, HistorySettings, HistorySnapshot, WriteResult } from '../../app/api';

export interface MockSnapshot {
  snapshot: HistorySnapshot;
  content: string;
}

export interface MockHistory {
  /** Key: vaultId + '|' + path; newest first. */
  snapshots: Map<string, MockSnapshot[]>;
  settings: HistorySettings;
  restored: { vaultId: string; id: string }[];
}

export function newMockHistory(): MockHistory {
  return {
    snapshots: new Map(),
    settings: { intervalMinutes: 5, retentionDays: 7, maxFileMb: 5, maxTotalMb: 500 },
    restored: [],
  };
}

interface Host {
  files(vaultId: string): Map<string, string>;
  changed(vaultId: string, paths: string[]): void;
  hash(text: string): string;
}

/** The functions Wails would expose as window.go.app.HistoryAPI. */
export function createHistoryAPI(h: MockHistory, host: Host) {
  const find = (id: string): [string, MockSnapshot] | undefined => {
    for (const [key, list] of h.snapshots) {
      const hit = list.find((s) => s.snapshot.id === id);
      if (hit) return [key, hit];
    }
    return undefined;
  };
  return {
    List: (vaultId: string, path: string): Promise<HistorySnapshot[]> =>
      Promise.resolve((h.snapshots.get(`${vaultId}|${path}`) ?? []).map((s) => s.snapshot)),
    Read: (_vaultId: string, id: string) => {
      const hit = find(id);
      return hit
        ? Promise.resolve({ snapshot: hit[1].snapshot, content: hit[1].content })
        : Promise.reject(new Error('not-found: snapshot not found'));
    },
    Restore: (vaultId: string, id: string): Promise<WriteResult> => {
      const hit = find(id);
      if (!hit) return Promise.reject(new Error('not-found: snapshot not found'));
      const { snapshot, content } = hit[1];
      const files = host.files(vaultId);
      const current = files.get(snapshot.path);
      h.restored.push({ vaultId, id });
      if (current !== undefined && current !== content) {
        const list = h.snapshots.get(hit[0]) ?? [];
        list.unshift({
          snapshot: {
            id: `pre-${list.length}-${id}`,
            path: snapshot.path,
            time: new Date().toISOString(),
            size: current.length,
            hash: host.hash(current),
            reason: 'pre-restore',
          },
          content: current,
        });
        h.snapshots.set(hit[0], list);
      }
      files.set(snapshot.path, content);
      host.changed(vaultId, [snapshot.path]);
      return Promise.resolve({
        path: snapshot.path,
        hash: host.hash(content),
        size: content.length,
      });
    },
    ListDeleted: (vaultId: string): Promise<HistoryDeleted[]> => {
      const files = host.files(vaultId);
      const out: HistoryDeleted[] = [];
      for (const [key, list] of h.snapshots) {
        const first = list[0];
        if (!key.startsWith(`${vaultId}|`) || !first || files.has(first.snapshot.path)) continue;
        out.push({
          path: first.snapshot.path,
          snapshotId: first.snapshot.id,
          time: first.snapshot.time,
          size: first.snapshot.size,
        });
      }
      return Promise.resolve(out);
    },
    GetSettings: (): Promise<HistorySettings> => Promise.resolve({ ...h.settings }),
    SetSettings: (_vaultId: string, s: HistorySettings): Promise<HistorySettings> => {
      h.settings = { ...s };
      return Promise.resolve({ ...h.settings });
    },
  };
}
