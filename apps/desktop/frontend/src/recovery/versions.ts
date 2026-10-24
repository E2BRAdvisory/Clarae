import type { HistorySnapshot, RevisionInfo } from '../app/api';

/** One restorable version of a note, from this device or from the cloud history. */
export type Version =
  | { source: 'local'; key: string; time: string; snapshot: HistorySnapshot }
  | { source: 'cloud'; key: string; time: string; revision: RevisionInfo };

/**
 * Local snapshots and cloud revisions in one list, newest first. Cloud revisions that carry no
 * content (deletions) cannot be viewed or restored and are left out.
 */
export function mergeVersions(local: HistorySnapshot[], cloud: RevisionInfo[]): Version[] {
  const out: Version[] = [
    ...local.map((snapshot): Version => ({
      source: 'local',
      key: `l:${snapshot.id}`,
      time: snapshot.time,
      snapshot,
    })),
    ...cloud
      .filter((revision) => revision.hasContent)
      .map((revision): Version => ({
        source: 'cloud',
        key: `c:${revision.rev}`,
        time: revision.time,
        revision,
      })),
  ];
  return out.sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.key.localeCompare(b.key));
}
