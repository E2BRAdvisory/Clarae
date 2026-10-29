// Figures shown in the Statistics tab. The calculations are pure; the panel supplies the data
// (note text, file entry, local snapshots, cloud revisions, shares).
import { extract, parseProperties, splitFrontmatter } from '@memobrain/markdown';
import type { RevisionInfo, ShareGrant, ShareInfo } from '../app/api';

const countWords = (s: string): number => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

export interface TextFigures {
  words: number;
  chars: number;
  headings: number;
}

/** Words, characters and headings of the body of a note (frontmatter excluded). */
export function textFigures(path: string, src: string): TextFigures {
  const body = splitFrontmatter(src).body;
  return {
    words: countWords(body),
    chars: body.length,
    headings: extract(path, src).headings.length,
  };
}

export type CreatedSource = 'frontmatter' | 'cloud' | 'modified';

/**
 * When the note was created. The file system does not keep a portable birth time (and a synced
 * copy would show the download time), so, like the graph view (ADR-0013): the frontmatter
 * "created" property; else the first cloud revision; else the last modification.
 */
export function createdOf(
  src: string,
  firstRevision: string | undefined,
  modified: string | undefined,
): { time: string | undefined; source: CreatedSource; dateOnly: boolean } {
  const raw = parseProperties(src)['created'];
  const fm = raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (Number.isFinite(fm))
    return {
      time: new Date(fm).toISOString(),
      source: 'frontmatter',
      // "2025-05-04" has no time of day: it must not be shown shifted by the time zone.
      dateOnly: typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()),
    };
  if (firstRevision) return { time: firstRevision, source: 'cloud', dateOnly: false };
  return { time: modified, source: 'modified', dateOnly: false };
}

/** The grants of the shares of a vault that cover `path` (the whole vault, a folder, the file). */
export function grantsCovering(shares: ShareInfo[], path: string): ShareGrant[] {
  const covers = (s: ShareInfo): boolean =>
    s.resourceType === 'vault' ||
    (s.resourceType === 'folder' &&
      (path === s.pathPrefix || path.startsWith(`${s.pathPrefix}/`))) ||
    (s.resourceType === 'file' && path === s.pathPrefix);
  const seen = new Set<string>();
  const out: ShareGrant[] = [];
  for (const s of shares.filter(covers))
    for (const g of s.grants) {
      const key = `${g.principalType}:${g.principalId}`;
      if (g.status === 'declined' || seen.has(key)) continue;
      seen.add(key);
      out.push(g);
    }
  return out;
}

/** Who made the newest cloud revision: `mine`, or the name found among the grants, or unknown. */
export function lastEditor(
  revisions: RevisionInfo[],
  grants: ShareGrant[],
): { kind: 'me' } | { kind: 'user'; name: string } | { kind: 'unknown' } | null {
  const newest = revisions[0];
  if (!newest) return null;
  if (newest.mine) return { kind: 'me' };
  const g = grants.find((x) => x.principalType === 'user' && x.principalId === newest.authorId);
  return g ? { kind: 'user', name: g.principalName } : { kind: 'unknown' };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
