#!/usr/bin/env node
// Guard of the rebrand to "Clarae notanda" (ADR-0052), run by `task lint-brand` (in `task lint`).
// The old product name may appear only where scripts/rebrand/allowlist.tsv says so: the frozen
// cryptographic labels, the compatibility code for data and clients of 1.x, fixtures in the old
// format and historical records. It fails on
//  - an occurrence of the old name (any casing) in the content or in the path of a file that is
//    tracked or untracked-but-not-ignored, outside the allowlist;
//  - an allowlist line that covers nothing any more, so the list follows the code and only shrinks.
// Usage: node scripts/rebrand/check.mjs [--list]   (--list prints what each line covers)
// The rules live in scripts/rebrand/lib.mjs (tests: node --test 'scripts/rebrand/*.test.mjs').
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OLD, entriesFor, occurrences, parseAllowlist, wholeFile } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const list = process.argv.includes('--list');

function git(...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  // git grep exits 1 when nothing matches.
  if (r.status !== 0 && !(args[0] === 'grep' && r.status === 1)) {
    throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
  return r.stdout.split('\0').filter(Boolean);
}

const entries = parseAllowlist(readFileSync(join(root, 'scripts/rebrand/allowlist.tsv'), 'utf8'));
const covered = new Map(entries.map((e) => [e, 0]));
const problems = [];

// Paths: every file git knows or would add.
for (const path of git('ls-files', '-z', '-co', '--exclude-standard')) {
  OLD.lastIndex = 0;
  if (!OLD.test(path)) continue;
  const es = entriesFor(entries, path);
  const whole = es.find((e) => e.whole);
  if (whole) covered.set(whole, covered.get(whole) + 1);
  else problems.push(`${path}: the path holds the old name`);
}

// Content: text files only (-I), in any casing.
for (const path of git(
  'grep',
  '-z',
  '-l',
  '-I',
  '-i',
  '--untracked',
  '--exclude-standard',
  '-e',
  'memobrain',
)) {
  const es = entriesFor(entries, path);
  const whole = es.find((e) => e.whole);
  if (whole) {
    wholeFile(es);
    covered.set(whole, covered.get(whole) + 1);
    continue;
  }
  readFileSync(join(root, path), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const before = es.map((e) => e.used);
      for (const o of occurrences(es, line)) {
        if (!o.allowed) problems.push(`${path}:${i + 1}: ${o.text}: ${line.trim().slice(0, 140)}`);
      }
      es.forEach((e, k) => {
        if (e.used && !before[k]) covered.set(e, covered.get(e) + 1);
        else if (e.used && !e.whole) {
          e.re.lastIndex = 0;
          if (e.re.test(line)) covered.set(e, covered.get(e) + 1);
        }
      });
    });
}

for (const e of entries) {
  if (covered.get(e) === 0) {
    problems.push(
      `scripts/rebrand/allowlist.tsv:${e.line}: covers nothing any more (${e.glob}): remove the line`,
    );
  }
}

if (list) {
  for (const e of entries)
    console.log(`${String(covered.get(e)).padStart(5)}  ${e.cls.padEnd(8)} ${e.glob}`);
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(
    `\nrebrand: ${problems.length} problem(s). The product is "Clarae notanda" (identifiers: clarae). ` +
      'If the old name is needed (compatibility with 1.x data), add a line to scripts/rebrand/allowlist.tsv with the reason.',
  );
  process.exit(1);
}
console.log(`rebrand: ok (${entries.length} allowlist lines)`);
