import { describe, expect, it } from 'vitest';
import {
  CALLOUT_RE,
  FOOTREF as FOOTREF_RULE,
  HIGHLIGHT as HIGHLIGHT_RULE,
  INLINE_MATH as INLINE_MATH_RULE,
  inlineFootnotes,
  isValidTag,
  parseCalloutHead,
  scanInline,
  stripInlineCode,
  type InlineSpan,
  type BlockState,
} from './inline';

const fresh = (): BlockState => ({ inMath: false, inComment: false });

function scan(line: string, st: BlockState = fresh()): InlineSpan[] {
  return scanInline(line, st);
}
function kinds(line: string, st?: BlockState): string[] {
  return scan(line, st).map((s) => s.kind);
}
/** The source text of every span of a kind. */
function texts(line: string, kind: InlineSpan['kind']): string[] {
  return scan(line)
    .filter((s) => s.kind === kind)
    .map((s) => line.slice(s.from, s.to));
}

describe('scanInline: wikilinks and embeds', () => {
  it('reads target, heading, block and alias with their offsets', () => {
    const line = 'see [[ Note #Part |the note]] now';
    const [w] = scan(line);
    expect(w).toMatchObject({
      kind: 'wikilink',
      embed: false,
      target: 'Note',
      heading: 'Part ', // as the indexer: only the target is trimmed
      block: '',
      alias: 'the note',
    });
    if (w?.kind !== 'wikilink') throw new Error('not a wikilink');
    expect(line.slice(w.from, w.to)).toBe('[[ Note #Part |the note]]');
    expect(line.slice(w.targetFrom, w.targetTo)).toBe('Note');
    expect(line.slice(w.innerFrom, w.innerTo)).toBe(' Note #Part |the note');
    expect(line.slice(w.aliasFrom ?? 0)).toBe('the note]] now');
  });

  it('reads a block reference and a wikilink without alias', () => {
    const [w] = scan('[[a#^b1]]');
    expect(w).toMatchObject({
      kind: 'wikilink',
      target: 'a',
      heading: '',
      block: 'b1',
      aliasFrom: null,
    });
  });

  it('keeps the size or alignment of an embed in the alias', () => {
    const [a, b] = scan('![[i.png|300]] ![[i.png|300|left]]');
    expect(a).toMatchObject({ embed: true, alias: '300' });
    expect(b).toMatchObject({ embed: true, alias: '300|left' });
  });

  it('skips an escaped bracket and an escaped embed', () => {
    expect(kinds('\\[[x]]')).toEqual([]);
    expect(kinds('\\![[x]]')).toEqual([]);
    expect(kinds('a [[x]] \\[[y]]')).toEqual(['wikilink']);
  });

  it('finds nothing inside inline code', () => {
    expect(kinds('`[[x]]` and `#t`')).toEqual([]);
    expect(texts('`[[x]]` [[y]]', 'wikilink')).toEqual(['[[y]]']);
  });
});

describe('scanInline: Markdown links', () => {
  it('tells internal from external links and gives the path span', () => {
    const line = '[t](a%20b.md#h) ![i](img.png) [u](https://x.io/p#a) [m](mailto:a@b.c)';
    const links = scan(line).filter((s) => s.kind === 'link');
    expect(links.map((l) => l.kind === 'link' && [l.linkKind, l.embed, l.target])).toEqual([
      ['markdown', false, 'a%20b.md#h'],
      ['markdown', true, 'img.png'],
      ['external', false, 'https://x.io/p#a'],
      ['external', false, 'mailto:a@b.c'],
    ]);
    const first = links[0];
    if (first?.kind !== 'link') throw new Error('not a link');
    expect(line.slice(first.targetFrom, first.targetTo)).toBe('a%20b.md');
    expect(first.text).toBe('t');
  });

  it('accepts an optional title and rejects a target with spaces', () => {
    expect(texts('[t](a.md "Title")', 'link')).toEqual(['[t](a.md "Title")']);
    expect(kinds('[t](a b.md)')).toEqual([]);
  });

  it('keeps wikilinks and Markdown links in document order', () => {
    expect(kinds('[a](x.md) [[b]] [c](y.md)')).toEqual(['link', 'wikilink', 'link']);
  });
});

describe('scanInline: tags', () => {
  it('finds tags after a boundary, with their name', () => {
    const line = '#a (#b) x,#c/d [#e] #f-g';
    const tags = scan(line).filter((s) => s.kind === 'tag');
    expect(tags.map((t) => t.kind === 'tag' && t.name)).toEqual(['a', 'b', 'c/d', 'e', 'f-g']);
    expect(tags.map((t) => line.slice(t.from, t.to))).toEqual(['#a', '#b', '#c/d', '#e', '#f-g']);
  });

  it('needs a boundary before the #: **a**#b is not a tag', () => {
    expect(kinds('**a**#b')).toEqual([]);
    expect(kinds('a#b')).toEqual([]);
    expect(kinds('**a** #b')).toEqual(['tag']);
  });

  it('rejects numeric tags and heading markers', () => {
    expect(kinds('#123 #1/2 # nope')).toEqual([]);
    expect(kinds('#1a')).toEqual(['tag']);
    expect(isValidTag('2024')).toBe(false);
  });

  it('does not look inside URLs, links or code', () => {
    expect(kinds('https://x.io/#frag')).toEqual([]);
    expect(kinds('[t](a.md#h)')).toEqual(['link']);
    expect(kinds('`#t`')).toEqual([]);
  });

  it('keeps unicode names', () => {
    expect(scan('#città')[0]).toMatchObject({ kind: 'tag', name: 'città' });
  });
});

describe('scanInline: block ids', () => {
  it('finds a trailing ^id', () => {
    const line = 'para ^abc-1';
    const [b] = scan(line);
    expect(b).toMatchObject({ kind: 'blockId', id: 'abc-1' });
    expect(line.slice(b?.from, b?.to)).toBe('^abc-1');
  });

  it('is only the last thing of the line and needs a space before it', () => {
    expect(kinds('a ^id more')).toEqual([]);
    expect(kinds('a^id')).toEqual([]);
    expect(kinds('a ^id  \t')).toEqual(['blockId']);
    expect(kinds('[[x]] ^id')).toEqual(['wikilink', 'blockId']);
  });

  it('is not seen inside a comment', () => {
    expect(kinds('a %% ^id %%')).toEqual(['comment']);
  });
});

describe('scanInline: highlight, math and footnotes', () => {
  it('finds ==highlights== with no space next to the delimiters', () => {
    expect(scan('a ==hi there== b')[0]).toMatchObject({ kind: 'highlight', text: 'hi there' });
    expect(kinds('== no ==')).toEqual([]);
  });

  it('finds inline math, not prices nor escaped dollars', () => {
    const line = 'x $a+b$ y';
    const [m] = scan(line);
    expect(m).toMatchObject({ kind: 'inlineMath', tex: 'a+b' });
    expect(line.slice(m?.from, m?.to)).toBe('$a+b$');
    expect(kinds('costs $5 and $6')).toEqual([]);
    expect(kinds('\\$a$')).toEqual([]);
    expect(kinds('$ a $')).toEqual([]);
  });

  it('finds footnote references and definitions', () => {
    expect(scan('text[^1] more')[0]).toMatchObject({ kind: 'footnoteRef', label: '1' });
    const def = scan('[^note]: the text');
    expect(def.map((s) => s.kind)).toEqual(['footnoteDef']);
    expect(def[0]).toMatchObject({ label: 'note', from: 0, to: 8 });
  });

  it('finds inline footnotes with nested brackets, not escaped or unclosed ones', () => {
    const line = 'a^[see [[Note]] too] b';
    expect(texts(line, 'footnoteInline')).toEqual(['^[see [[Note]] too]']);
    expect(kinds('\\^[x]')).toEqual([]);
    expect(kinds('a ^[open')).toEqual([]);
    expect(inlineFootnotes('^[a] ^[b ^[c]]')).toBe(2);
  });
});

describe('scanInline: tasks', () => {
  it('reads state and text, with the marker span', () => {
    const line = '  - [x] done it';
    const [t] = scan(line);
    expect(t).toMatchObject({ kind: 'task', state: 'x', text: 'done it' });
    expect(line.slice(t?.from, t?.to)).toBe('[x]');
  });

  it('accepts ordered items and quotes, rejects plain brackets', () => {
    expect(kinds('1. [ ] a')).toEqual(['task']);
    expect(kinds('> - [/] a')).toEqual(['task']);
    expect(kinds('[ ] a')).toEqual([]);
  });
});

describe('scanInline: comments, math blocks and state', () => {
  it('reports comment and math blocks as the block scanner does', () => {
    expect(scan('a %%c%% b $$m$$')).toEqual([
      { kind: 'comment', from: 2, to: 7, continued: false, closed: true },
      { kind: 'math', from: 10, to: 15, continued: false, closed: true },
    ]);
  });

  it('hides everything inside comments and math', () => {
    expect(kinds('%% [[a]] #t ==h== %%')).toEqual(['comment']);
    expect(kinds('$$ [[a]] #t $$')).toEqual(['math']);
  });

  it('carries a multi-line comment and finds what follows its end', () => {
    const st = fresh();
    expect(kinds('start %% open [[a]]', st)).toEqual(['comment']);
    expect(st.inComment).toBe(true);
    expect(kinds('[[b]] #t - [ ] x', st)).toEqual(['comment']);
    expect(kinds('end %% [[c]] #u', st)).toEqual(['comment', 'wikilink', 'tag']);
    expect(st.inComment).toBe(false);
  });

  it('does not report task, footnote definition or inline footnote on a continued line', () => {
    const st = fresh();
    scan('%% open', st);
    expect(kinds('- [ ] t %% [^a]: x ^[n] [[c]]', st)).toEqual(['comment', 'wikilink']);
    expect(kinds('- [ ] t', st)).toEqual(['task']);
  });

  it('carries a math block', () => {
    const st = fresh();
    scan('$$', st);
    expect(st.inMath).toBe(true);
    expect(kinds('x = [[no]]', st)).toEqual(['math']);
    expect(kinds('$$ [[yes]]', st)).toEqual(['math', 'wikilink']);
    expect(st.inMath).toBe(false);
  });

  it('sorts spans by position, allowing overlaps', () => {
    const line = '==see [[a]] #t==';
    const spans = scan(line);
    expect(spans.map((s) => s.kind)).toEqual(['highlight', 'wikilink', 'tag']);
    expect(spans.map((s) => s.from)).toEqual([...spans.map((s) => s.from)].sort((a, b) => a - b));
  });
});

describe('scanInline: code blocks', () => {
  it('does not track fences: the caller decides which lines are code', () => {
    const st = fresh();
    expect(kinds('```ts', st)).toEqual([]);
    expect(kinds('[[x]] #t', st)).toEqual(['wikilink', 'tag']);
    expect(st).toEqual(fresh());
  });
});

describe('exported regexes', () => {
  it('hold no state: no global flag, repeated test() gives the same answer', () => {
    for (const re of [HIGHLIGHT_RULE, INLINE_MATH_RULE, FOOTREF_RULE])
      expect(re.global).toBe(false);
    expect(HIGHLIGHT_RULE.test('a ==b== c')).toBe(true);
    expect(HIGHLIGHT_RULE.test('a ==b== c')).toBe(true);
    expect(INLINE_MATH_RULE.test('$x$')).toBe(true);
    expect(INLINE_MATH_RULE.test('$x$')).toBe(true);
    expect(FOOTREF_RULE.test('[^1]')).toBe(true);
    expect(FOOTREF_RULE.test('[^1]')).toBe(true);
  });
});

describe('callout head', () => {
  it('parses type, fold marker and title', () => {
    expect(parseCalloutHead('> [!Warning]- Careful ')).toEqual({
      prefixLength: 2,
      type: 'warning',
      marker: '-',
      title: 'Careful',
    });
    expect(parseCalloutHead('>> [!note]')).toMatchObject({
      prefixLength: 3,
      marker: '',
      title: '',
    });
    expect(parseCalloutHead('> plain')).toBeNull();
    expect(CALLOUT_RE.test('> [!tip]+ x')).toBe(true);
  });
});

// The Live Preview scanner of the workbench (editor/livePreview.ts, ofmLine) used to keep its own
// copy of these rules. Its regex pipeline, as it was at HEAD before the move to this package, is
// reproduced here (every regex copied verbatim, none imported) to show that scanInline finds the
// same ranges. Known difference: a ^block-id may be preceded by any whitespace, as in
// the indexer (livePreview only accepted space and tab; CodeMirror lines have no CR/FF/VT).
describe('equivalence with the Live Preview rules', () => {
  const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/dg;
  const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>)]+/g;
  const TAG = /(^|[ \t\n\f\r([{,;])#([\p{L}\p{N}_\-/]+)/gu;
  const BLOCK_ID = /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/;
  const HIGHLIGHT = /==(?=\S)([^\n]+?)(?<=\S)==/g;
  const INLINE_MATH = /(?<![\\$])\$(?![\s$])([^$\n]+?)(?<![\s\\])\$(?!\d)/g;
  const FOOTREF = /\[\^[^\]\s]+\](?!:)/g;

  /** livePreview.ts ofmLine, reduced to the ranges it decorates. */
  function reference(text: string, st: BlockState): string[] {
    const out: string[] = [];
    const clean0 = stripInlineCode(text);
    let visible = clean0;
    // The block spans are the same function in both: only the rest is compared.
    const blocks = scanInline(text, { ...st }).filter(
      (s) => s.kind === 'comment' || s.kind === 'math',
    );
    for (const sp of blocks) {
      out.push(`${sp.kind}:${sp.from}-${sp.to}`);
      visible = visible.slice(0, sp.from) + ' '.repeat(sp.to - sp.from) + visible.slice(sp.to);
    }
    for (const m of visible.matchAll(WIKILINK)) {
      const idx = (m as RegExpMatchArray & { indices: [number, number][] }).indices;
      const [m0, m1] = idx[0] as [number, number];
      if (m0 > 0 && visible[m0 - 1] === '\\') continue;
      out.push(`wikilink:${m0}-${m1}`);
    }
    const noWiki = visible.replace(new RegExp(WIKILINK.source, 'g'), (s) => ' '.repeat(s.length));
    for (const m of noWiki.matchAll(HIGHLIGHT)) {
      out.push(`highlight:${m.index}-${(m.index ?? 0) + m[0].length}`);
    }
    for (const m of noWiki.matchAll(INLINE_MATH)) {
      out.push(`inlineMath:${m.index}-${(m.index ?? 0) + m[0].length}`);
    }
    for (const m of noWiki.matchAll(FOOTREF)) {
      out.push(`footnoteRef:${m.index}-${(m.index ?? 0) + m[0].length}`);
    }
    const noUrl = noWiki
      .replace(URL_RE, (s) => ' '.repeat(s.length))
      .replace(MD_LINK, (s) => ' '.repeat(s.length));
    for (const m of noUrl.matchAll(TAG)) {
      const name = m[2] ?? '';
      if (!isValidTag(name)) continue;
      const s = (m.index ?? 0) + (m[1] ?? '').length;
      out.push(`tag:${s}-${s + 1 + name.length}`);
    }
    const b = BLOCK_ID.exec(visible);
    if (b) {
      const s = (b.index ?? 0) + 1;
      out.push(`blockId:${s}-${s + 1 + (b[1] ?? '').length}`);
    }
    return out.sort();
  }

  /** The same ranges as scanInline reports them (kinds the Live Preview decorates). */
  function viaScanInline(text: string, st: BlockState): string[] {
    const wanted = new Set([
      'comment',
      'math',
      'wikilink',
      'highlight',
      'inlineMath',
      'footnoteRef',
      'tag',
      'blockId',
    ]);
    return scanInline(text, st)
      .filter((s) => wanted.has(s.kind))
      .map((s) => `${s.kind}:${s.from}-${s.to}`)
      .sort();
  }

  const doc = [
    'Plain [[Note|alias]] and ![[img.png|300x200]] with #tag and ==high== and $x^2$ and [^1].',
    '`[[code]] #nocode` [[ok]] \\[[escaped]] \\![[escaped]]',
    '**a**#b (#c) a#d [#e] 100 #123 #1a',
    'https://x.io/#frag [t](a.md#h) [[a#h]] #real',
    'costs $5 and $6, ==  == ==x==, ^[inline [[n]]] [^f]: def',
    'a %%inline%% b [[c]] %% open [[hidden]]',
    'still hidden #t ==h== $a$',
    'end %% now [[visible]] ^blk',
    'x $$ display [[z]]',
    'inside math #t',
    'close $$ and #after',
    'last line ==h [[a]] h== #x ^id1',
    'Ünïcode #città [[Nota è]] ^abc-1',
  ];

  it('exports exactly the verbatim rules (modulo the g flag)', () => {
    expect(HIGHLIGHT_RULE.source).toBe(HIGHLIGHT.source);
    expect(INLINE_MATH_RULE.source).toBe(INLINE_MATH.source);
    expect(FOOTREF_RULE.source).toBe(FOOTREF.source);
  });

  it('finds the same ranges on every line, carrying the same state', () => {
    const a = fresh();
    const b = fresh();
    for (const line of doc) {
      const expected = reference(line, { ...a });
      const got = viaScanInline(line, b);
      expect(got, line).toEqual(expected);
      // Both advance their state with the same scanner.
      scanInline(line, a);
    }
    expect(a).toEqual(b);
  });

  it('documents the only difference: block ids after any whitespace', () => {
    expect(viaScanInline('a\f^id', fresh())).toEqual(['blockId:2-5']);
    expect(reference('a\f^id', fresh())).toEqual([]);
  });
});
