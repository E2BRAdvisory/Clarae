#!/usr/bin/env node
// The mechanical pass of the rebrand to "Clarae notanda" (ADR-0052): renames the old product name
// in the content and in the paths of the tracked files, except where scripts/rebrand/allowlist.tsv
// allows it. Run once, by scripts/rebrand/run.sh, on a clean tree. Generated protobuf code is left
// to `task gen` (its descriptors hold length-prefixed strings).
// Usage: node scripts/rebrand/rename.mjs [--dry-run]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OLD, entriesFor, parseAllowlist, renameLine, renameText } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dry = process.argv.includes('--dry-run');
const REGENERATED = /\.pb\.go$/;

function git(...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0 && !(args[0] === 'grep' && r.status === 1))
    throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

const entries = parseAllowlist(readFileSync(join(root, 'scripts/rebrand/allowlist.tsv'), 'utf8'));
const whole = (path) => entriesFor(entries, path).some((e) => e.whole);

let files = 0;
let lines = 0;
for (const path of git('grep', '-z', '-l', '-I', '-i', '-e', 'memobrain')) {
  if (whole(path) || REGENERATED.test(path)) continue;
  const es = entriesFor(entries, path);
  const before = readFileSync(join(root, path), 'utf8');
  const after = before
    .split('\n')
    .map((line) => {
      const out = renameLine(es, line);
      if (out !== line) lines++;
      return out;
    })
    .join('\n');
  if (after === before) continue;
  files++;
  if (!dry) writeFileSync(join(root, path), after);
}

let moved = 0;
for (const path of git('ls-files', '-z')) {
  OLD.lastIndex = 0;
  if (!OLD.test(path) || whole(path)) continue;
  const to = renameText(path);
  moved++;
  if (dry) {
    console.log(`mv ${path} -> ${to}`);
    continue;
  }
  mkdirSync(dirname(join(root, to)), { recursive: true });
  git('mv', path, to);
}

console.log(
  `rebrand: ${dry ? 'would rename' : 'renamed'} ${lines} lines in ${files} files, ${moved} paths`,
);
