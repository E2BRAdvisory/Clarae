import { describe, expect, it } from 'vitest';
import type { RevisionInfo, Share, ShareGrant } from '../app/api';
import { createdOf, formatSize, grantsCovering, lastEditor, textFigures } from './noteStats';

const grant = (id: string, name: string, over: Partial<ShareGrant> = {}): ShareGrant => ({
  principal_type: 'user',
  principal_id: id,
  principal_name: name,
  permission: 'editor',
  status: 'accepted',
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});
const share = (over: Partial<Share>): Share =>
  ({
    id: 's',
    vault_id: 'v',
    resource_type: 'vault',
    grants: [],
    ...over,
  }) as Share;
const rev = (over: Partial<RevisionInfo>): RevisionInfo =>
  ({ rev: 1, authorId: 'u1', mine: false, time: '2026-01-01T00:00:00Z', ...over }) as RevisionInfo;

describe('textFigures', () => {
  it('counts the body only and the headings', () => {
    const f = textFigures('a.md', '---\ntitle: x y z\n---\n# One\nhello brave world\n## Two\n');
    expect(f.words).toBe(5); // One hello brave world Two
    expect(f.headings).toBe(2);
    expect(f.chars).toBe('# One\nhello brave world\n## Two\n'.length);
  });
});

describe('createdOf', () => {
  const modified = '2026-03-01T10:00:00.000Z';
  it('prefers the frontmatter, then the first cloud revision, then the modification time', () => {
    expect(createdOf('---\ncreated: 2025-05-04\n---\nx', '2026-01-01T00:00:00Z', modified)).toEqual(
      {
        time: '2025-05-04T00:00:00.000Z',
        source: 'frontmatter',
        dateOnly: true,
      },
    );
    expect(createdOf('x', '2026-01-01T00:00:00Z', modified)).toEqual({
      time: '2026-01-01T00:00:00Z',
      source: 'cloud',
      dateOnly: false,
    });
    expect(createdOf('---\ncreated: not a date\n---\nx', undefined, modified)).toEqual({
      time: modified,
      source: 'modified',
      dateOnly: false,
    });
    expect(
      createdOf('---\ncreated: 2025-05-04T08:30:00Z\n---\nx', undefined, modified).dateOnly,
    ).toBe(false);
  });
});

describe('sharing', () => {
  it('collects the grants of the shares that cover the note, once per recipient', () => {
    const shares = [
      share({
        resource_type: 'vault',
        grants: [grant('u1', 'Ada'), grant('g1', 'Team', { principal_type: 'group' })],
      }),
      share({
        resource_type: 'folder',
        path_prefix: 'Docs',
        grants: [grant('u1', 'Ada'), grant('u2', 'Bob')],
      }),
      share({ resource_type: 'file', path_prefix: 'Other/x.md', grants: [grant('u3', 'Cy')] }),
      share({ resource_type: 'folder', path_prefix: 'Doc', grants: [grant('u4', 'Di')] }), // not a parent of Docs/
      share({
        resource_type: 'folder',
        path_prefix: 'Docs',
        grants: [grant('u5', 'Ed', { status: 'declined' })],
      }),
    ];
    expect(grantsCovering(shares, 'Docs/a.md').map((g) => g.principal_name)).toEqual([
      'Ada',
      'Team',
      'Bob',
    ]);
    expect(grantsCovering(shares, 'Other/x.md').map((g) => g.principal_name)).toEqual([
      'Ada',
      'Team',
      'Cy',
    ]);
  });

  it('names the last editor from the grants', () => {
    const grants = [grant('u1', 'Ada')];
    expect(lastEditor([], grants)).toBeNull();
    expect(lastEditor([rev({ mine: true })], grants)).toEqual({ kind: 'me' });
    expect(lastEditor([rev({ authorId: 'u1' })], grants)).toEqual({ kind: 'user', name: 'Ada' });
    expect(lastEditor([rev({ authorId: 'zzz' })], grants)).toEqual({ kind: 'unknown' });
  });
});

describe('formatSize', () => {
  it('uses B, KB and MB', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
