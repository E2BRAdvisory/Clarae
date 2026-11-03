import { beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../app/api';
import { installWailsMock } from '.';

// The link resolution of the mock against the fixture the core runs too (apps/desktop/internal/links
// conformance_test.go): the e2e suites on the mock see the links as the core resolves them.
interface ResolveFixture {
  files: { path: string; aliases?: string[] }[];
  cases: { note: string; from: string; target: string; expected: string }[];
}

const fixture = JSON.parse(
  Object.values(
    import.meta.glob<string>('../../../../../shared/conformance/links/resolve.json', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0] ?? '{}',
) as ResolveFixture;

/** What the fixture's file holds: a note with its aliases in the frontmatter (as the Go test writes it). */
const content = (aliases: string[] | undefined): string =>
  aliases?.length ? `---\naliases: [${aliases.join(', ')}]\n---\n# note\n` : '# note\n';

let vaultId = '';

beforeAll(async () => {
  const mock = installWailsMock();
  vaultId = (await api.vault.open('/vaults/Links')).id;
  const v = mock.vaults.get(vaultId);
  if (!v) throw new Error('no mock vault');
  v.files.clear();
  v.binaries.clear();
  for (const f of fixture.files) {
    if (f.path.endsWith('.md')) v.files.set(f.path, content(f.aliases));
    else v.binaries.set(f.path, 'binary');
  }
});

describe('link resolution of the Wails mock (shared/conformance/links)', () => {
  it('has cases', () => {
    expect(fixture.cases?.length ?? 0).toBeGreaterThan(10);
  });

  it.each(fixture.cases ?? [])('$note', async (c) => {
    expect(await api.links.resolve(vaultId, c.from, c.target)).toBe(c.expected);
  });
});
