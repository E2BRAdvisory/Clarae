// The Live editor's Markdown layer as the third parser of the conformance regime (A-D5): the fixtures
// of shared/conformance/markdown (read by the Go parser and by the TS indexer) go through the
// Milkdown pipeline, and what the index extracts from the result is compared with expected.json.
// Two things are checked for each fixture:
//
//   1. the file read into the editor and written again, every block, is the file for the index:
//      extract() of the output is expected.json (a block written again may move the lines below it,
//      as a nested quote gets its blank `>` line: the lines are compared on the file as it is, and
//      not on this output);
//   2. the OFM constructs the document holds as nodes and marks (wikilinks, embeds, tags, block ids),
//      together with what is inside its raw nodes and its frontmatter, are exactly the ones the
//      fixture expects: the editor shows the constructs the index sees, no more and no less.
//
// Then the round trip of the fixtures: identity, ten idempotent rounds. The blocking criteria of the
// Live editor ride on this file, which `task conformance` runs: the escape invariant (B2) and the
// A gate (C1 to C4) on the roundtrip corpus.
import { extract, parseWikilinkInner } from '@memobrain/markdown';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveSession } from '../editor/live/fidelity/session';
import { createLiveCore, type LiveCore } from '../editor/live/headless';
import { describeEscapeInvariant } from '../editor/live/testing/escapeSuite';
import { describeGate } from '../editor/live/testing/gateSuite';

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../shared/conformance/markdown',
);

interface Expected {
  title: string;
  aliases: string[];
  properties: Record<string, unknown>;
  headings: { level: number; text: string; line: number }[];
  links: {
    line: number;
    kind: string;
    target: string;
    heading: string;
    block: string;
    alias: string;
    embed: boolean;
  }[];
  tags: { line: number; name: string }[];
  blockIds: { line: number; id: string }[];
  tasks: { line: number; state: string; text: string }[];
  footnotes: string[];
  wordCount: number;
}

const cases = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => {
    const name = f.replace(/\.md$/, '');
    return {
      name,
      source: readFileSync(join(dir, f), 'utf8'),
      expected: JSON.parse(readFileSync(join(dir, `${name}.expected.json`), 'utf8')) as Expected,
    };
  });

type Projection = ReturnType<typeof project>;

/** What the contract compares: the extraction, offsets apart. */
function project(name: string, md: string) {
  const d = extract(name, md);
  return {
    title: d.title,
    aliases: d.aliases,
    properties: d.properties,
    headings: d.headings,
    links: d.links.map(({ line, kind, target, heading, block, alias, embed }) => ({
      line,
      kind,
      target,
      heading,
      block,
      alias,
      embed,
    })),
    tags: d.tags,
    blockIds: d.blockIds,
    tasks: d.tasks,
    footnotes: d.footnotes,
    wordCount: d.wordCount,
  };
}

/** The same without the line numbers. */
function withoutLines<T extends Projection | Expected>(p: T): unknown {
  return JSON.parse(
    JSON.stringify(p, (k, v: unknown) => (k === 'line' ? undefined : v)),
  ) as unknown;
}

/** The wikilinks, tags and block ids a document holds as nodes and marks, as `kind:value` strings. */
function constructsOf(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'ofm_wikilink') {
      out.push(
        `${node.attrs['embed'] ? 'embed' : 'wikilink'}:${parseWikilinkInner(node.textContent).target}`,
      );
    }
    if (node.isText) {
      for (const m of node.marks) {
        if (m.type.name === 'ofm_tag') out.push(`tag:${(node.text ?? '').slice(1)}`);
        if (m.type.name === 'ofm_blockid') out.push(`blockId:${(node.text ?? '').slice(1)}`);
      }
    }
    return true;
  });
  return out;
}

/** What `extract` finds in the raw nodes of a document and in the frontmatter: not the editor's to hold. */
function constructsInRaw(doc: PMNode, frontmatter: string): string[] {
  const out: string[] = [];
  const add = (md: string): void => {
    const d = extract('t', md);
    for (const l of d.links)
      if (l.kind === 'wikilink') out.push(`${l.embed ? 'embed' : 'wikilink'}:${l.target}`);
    for (const t of d.tags) out.push(`tag:${t.name}`);
    for (const b of d.blockIds) out.push(`blockId:${b.id}`);
  };
  doc.descendants((node) => {
    if (node.type.name === 'raw_block' || node.type.name === 'raw_inline')
      add(String(node.attrs['raw']));
    return true;
  });
  if (frontmatter !== '') {
    const d = extract('t', frontmatter);
    for (const t of d.tags) out.push(`tag:${t.name}`);
  }
  return out;
}

let core: LiveCore;
beforeAll(async () => {
  core = await createLiveCore();
});
afterAll(() => core.destroy());

describe('conformance: the Live editor as the third parser', () => {
  it('has the fixtures', () => {
    expect(cases.length).toBeGreaterThanOrEqual(70);
  });

  for (const c of cases) {
    describe(c.name, () => {
      it('opens in the editor and is the file, byte for byte: the index sees what expected.json says', () => {
        const r = LiveSession.open(core, c.source);
        expect(r.ok).toBe(true);
        if (r.ok) expect(project(c.name, r.session.text(r.session.doc))).toEqual(c.expected);
      });

      it('written again, every block, it extracts as expected.json says', () => {
        const r = LiveSession.open(core, c.source);
        if (!r.ok) throw new Error(r.reason);
        const out = r.session.text(r.session.doc, { forceDirty: true });
        expect(withoutLines(project(c.name, out))).toEqual(withoutLines(c.expected));
      });

      it('holds as nodes and marks the constructs the fixture expects (outside raw and frontmatter)', () => {
        const r = LiveSession.open(core, c.source);
        if (!r.ok) throw new Error(r.reason);
        const expected = [
          ...c.expected.links
            .filter((l) => l.kind === 'wikilink')
            .map((l) => `${l.embed ? 'embed' : 'wikilink'}:${l.target}`),
          ...c.expected.tags.map((t) => `tag:${t.name}`),
          ...c.expected.blockIds.map((b) => `blockId:${b.id}`),
        ].sort();
        const held = [
          ...constructsOf(r.session.doc),
          ...constructsInRaw(r.session.doc, r.session.envelope.frontmatter),
        ].sort();
        expect(held).toEqual(expected);
      });

      it('survives ten round trips unchanged', () => {
        let cur = c.source;
        for (let i = 0; i < 10; i++) {
          const r = LiveSession.open(core, cur);
          if (!r.ok) throw new Error(r.reason);
          cur = r.session.text(r.session.doc, { forceDirty: true });
          expect(withoutLines(project(c.name, cur)), `round ${i + 1}`).toEqual(
            withoutLines(c.expected),
          );
        }
      });
    });
  }
});

describe('conformance: the escape invariant of the Live editor (B2)', describeEscapeInvariant);
describe('conformance: the round-trip corpus, the A gate (C1 to C4)', describeGate);
