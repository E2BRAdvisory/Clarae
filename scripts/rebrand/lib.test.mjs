import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  entriesFor,
  globToRegExp,
  occurrences,
  parseAllowlist,
  renameLine,
  renameText,
  wholeFile,
} from './lib.mjs';

const ALLOW = parseAllowlist(
  [
    '# comment',
    'frozen\tshared/go/vaultcrypto/**\tmemobrain/v[12]/(path-enc|path)\\b\tkey derivation',
    'history\tdocs/adr/**\t*\trecords',
    'legacy\tweb/src/storage.ts\tmemobrain-sqlite\tdata of 1.3',
  ].join('\n'),
);

test('renameText renames every casing, the product name first', () => {
  assert.equal(renameText('MemoBrain Notes'), 'Clarae notanda');
  assert.equal(renameText('MemoBrain\\ Notes.app'), 'Clarae\\ notanda.app');
  assert.equal(renameText('MemoBrain-Notes.AppDir'), 'Clarae-notanda.AppDir');
  assert.equal(renameText('a MemoBrain account'), 'a Clarae account');
  assert.equal(renameText('MemobrainClient'), 'ClaraeClient');
  assert.equal(renameText('MEMOBRAIN_DATA_DIR'), 'CLARAE_DATA_DIR');
  assert.equal(
    renameText('@memobrain/ui memobrain://x .memobrain/'),
    '@clarae/ui clarae://x .clarae/',
  );
  assert.equal(renameText('memobrain-notes: false'), 'clarae-notes: false');
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('docs/adr/**').test('docs/adr/0001-x.md'));
  assert.ok(globToRegExp('docs/**/*.md').test('docs/a.md'));
  assert.ok(globToRegExp('docs/**/*.md').test('docs/a/b/c.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
  assert.ok(!globToRegExp('docs/adr/**').test('docs/adrx/a.md'));
  assert.ok(globToRegExp('CHANGELOG.md').test('CHANGELOG.md'));
  assert.ok(!globToRegExp('CHANGELOG.md').test('CHANGELOGxmd'));
});

test('an allowed occurrence is kept, the rest of the line is renamed', () => {
  const es = entriesFor(ALLOW, 'shared/go/vaultcrypto/keys.go');
  assert.equal(
    renameLine(es, 'infoPathEnc = "memobrain/v1/path-enc" // memobrain/shared'),
    'infoPathEnc = "memobrain/v1/path-enc" // clarae/shared',
  );
  assert.equal(renameLine(es, 'import "memobrain/shared/x"'), 'import "clarae/shared/x"');
  // The same label in a file the entry does not name is renamed.
  assert.equal(
    renameLine(entriesFor(ALLOW, 'other.go'), '"memobrain/v1/path-enc"'),
    '"clarae/v1/path-enc"',
  );
});

test('occurrences reports what the allowlist does not cover and marks the entries used', () => {
  const allow = parseAllowlist(
    'legacy\tweb/src/storage.ts\tmemobrain-sqlite\tdata of 1.3\nhistory\tdocs/adr/**\t*\trecords',
  );
  const es = entriesFor(allow, 'web/src/storage.ts');
  const occ = occurrences(es, "const A = 'memobrain-sqlite', B = 'MemoBrain';");
  assert.deepEqual(
    occ.map((o) => [o.text, o.allowed]),
    [
      ['memobrain', true],
      ['MemoBrain', false],
    ],
  );
  assert.equal(allow[0].used, true);
  assert.equal(allow[1].used, false);
  assert.equal(wholeFile(entriesFor(allow, 'docs/adr/0001-x.md')), true);
  assert.equal(allow[1].used, true);
  assert.equal(wholeFile(es), false);
});

test('parseAllowlist rejects a malformed line', () => {
  assert.throws(() => parseAllowlist('frozen\tonly-two'), /line 1/);
  assert.throws(() => parseAllowlist('a\tb\t*\t'), /line 1/);
});
