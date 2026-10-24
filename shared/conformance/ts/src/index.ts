// Types and loader for the shared conformance fixtures (see ../../README.md).
// Mirrors shared/go/conformance so both parsers are checked against the same data.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LinkKind = 'wikilink' | 'markdown' | 'external';

export interface ExpectedHeading {
  level: number;
  text: string;
  line: number;
}

export interface ExpectedLink {
  line: number;
  kind: LinkKind;
  target: string;
  heading: string;
  block: string;
  alias: string;
  embed: boolean;
}

export interface ExpectedTag {
  line: number;
  name: string;
}

export interface ExpectedBlockId {
  line: number;
  id: string;
}

export interface ExpectedTask {
  line: number;
  state: string;
  text: string;
}

export interface Expected {
  title: string;
  aliases: string[];
  properties: Record<string, unknown>;
  headings: ExpectedHeading[];
  links: ExpectedLink[];
  tags: ExpectedTag[];
  blockIds: ExpectedBlockId[];
  tasks: ExpectedTask[];
  footnotes: string[];
  wordCount: number;
}

export interface MarkdownCase {
  name: string;
  source: string;
  expected: Expected;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path of a subdirectory of shared/conformance. */
export function conformanceDir(sub: 'markdown' | 'merge' | 'crypto'): string {
  return resolve(here, '..', '..', sub);
}

const LINK_KINDS: ReadonlySet<string> = new Set(['wikilink', 'markdown', 'external']);

function check(name: string, e: Expected): void {
  const fail = (msg: string): never => {
    throw new Error(`fixture ${name}: ${msg}`);
  };
  if (e.title !== name) fail(`title ${JSON.stringify(e.title)} must equal the case name`);
  for (const field of [
    'aliases',
    'headings',
    'links',
    'tags',
    'blockIds',
    'tasks',
    'footnotes',
  ] as const) {
    if (!Array.isArray(e[field])) fail(`${field} must be an array`);
  }
  if (typeof e.properties !== 'object' || e.properties === null)
    fail('properties must be an object');
  for (const h of e.headings) {
    if (h.level < 1 || h.level > 6 || h.line < 1 || !h.text)
      fail(`invalid heading ${JSON.stringify(h)}`);
  }
  for (const l of e.links) {
    if (!LINK_KINDS.has(l.kind)) fail(`invalid link kind ${l.kind}`);
    if (l.line < 1 || (!l.target && !l.heading && !l.block))
      fail(`invalid link ${JSON.stringify(l)}`);
  }
  for (const t of e.tags) {
    if (t.line < 1 || !t.name || t.name.startsWith('#')) fail(`invalid tag ${JSON.stringify(t)}`);
  }
  for (const b of e.blockIds) {
    if (b.line < 1 || !b.id) fail(`invalid block id ${JSON.stringify(b)}`);
  }
  for (const t of e.tasks) {
    if (t.line < 1 || t.state.length !== 1) fail(`invalid task ${JSON.stringify(t)}`);
  }
  if (e.wordCount < 0) fail('negative word count');
}

/** Loads every <case>.md with its <case>.expected.json, sorted by name. */
export function loadMarkdownCases(dir = conformanceDir('markdown')): MarkdownCase[] {
  const entries = readdirSync(dir).sort();
  const cases: MarkdownCase[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.slice(0, -'.md'.length);
    seen.add(name);
    const source = readFileSync(join(dir, entry), 'utf8');
    const expected = JSON.parse(
      readFileSync(join(dir, `${name}.expected.json`), 'utf8'),
    ) as Expected;
    check(name, expected);
    cases.push({ name, source, expected });
  }
  for (const entry of entries) {
    if (entry.endsWith('.expected.json') && !seen.has(entry.slice(0, -'.expected.json'.length))) {
      throw new Error(`expectation ${entry} has no .md input`);
    }
  }
  return cases;
}
