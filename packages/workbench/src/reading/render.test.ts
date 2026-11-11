import { describe, expect, it } from 'vitest';
import { prepareSource, renderMarkdown } from './render';
import { extractBlock, extractSection } from './sections';

const dom = (html: string): HTMLElement => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

describe('renderMarkdown', () => {
  it('renders wikilinks, embeds, highlights and tags', () => {
    const d = dom(
      renderMarkdown(
        'See [[Note#Part|the part]] and [[Plain]]. ![[img.png|200]] ==hot== #tag/x ^b1\n',
      ),
    );
    const links = [...d.querySelectorAll<HTMLAnchorElement>('a.wikilink')];
    expect(links.map((a) => [a.textContent, a.dataset['target'], a.dataset['heading']])).toEqual([
      ['the part', 'Note', 'Part'],
      ['Plain', 'Plain', ''],
    ]);
    const embed = d.querySelector<HTMLElement>('span.embed');
    expect(embed?.dataset['target']).toBe('img.png');
    expect(embed?.dataset['size']).toBe('200');
    expect(d.querySelector('mark')?.textContent).toBe('hot');
    expect(d.querySelector<HTMLAnchorElement>('a.tag')?.dataset['tag']).toBe('tag/x');
    expect(d.textContent).not.toContain('^b1');
  });

  it('applies the indexer rules: code, escapes and comments are not links', () => {
    const d = dom(
      renderMarkdown('`[[code]]` \\[[escaped]] %%[[hidden]]%% [[real]]\n\n```\n[[fence]]\n```\n'),
    );
    expect([...d.querySelectorAll('a.wikilink')].map((a) => a.textContent)).toEqual(['real']);
    expect(d.textContent).toContain('[[escaped]]');
    expect(d.textContent).not.toContain('hidden');
  });

  it('hides frontmatter, adds heading ids and renders callouts', () => {
    const d = dom(
      renderMarkdown(
        '---\ntitle: x\n---\n# Hello World\n## Hello World\n\n> [!warning] Careful\n> body\n\n> [!tip]- Folded\n> inner\n\n> [!note]+ Open\n> o\n',
      ),
    );
    expect(d.textContent).not.toContain('title: x');
    expect([...d.querySelectorAll('h1,h2')].map((h) => h.id)).toEqual([
      'hello-world',
      'hello-world-1',
    ]);
    const warn = d.querySelector('.callout-warning');
    expect(warn?.tagName).toBe('DIV');
    expect(warn?.querySelector('.callout-title')?.textContent).toBe('Careful');
    expect(warn?.querySelector('.callout-content')?.textContent?.trim()).toBe('body');
    const folded = d.querySelector('details.callout-tip');
    expect(folded?.hasAttribute('open')).toBe(false);
    expect(folded?.querySelector('summary')?.textContent).toBe('Folded');
    expect(d.querySelector('details.callout-note')?.hasAttribute('open')).toBe(true);
  });

  it('marks tasks with their state and keeps math as placeholders', () => {
    const d = dom(renderMarkdown('- [ ] a\n- [x] b\n- [/] c\n\n$x^2$ and\n\n$$\ny\n$$\n'));
    expect(
      [...d.querySelectorAll('li.task-list-item')].map((li) => [
        li.getAttribute('data-task'),
        li.textContent?.trim(),
      ]),
    ).toEqual([
      ['open', 'a'],
      ['x', 'b'],
      ['/', 'c'],
    ]);
    expect(d.querySelector('.math-inline')?.textContent).toBe('x^2');
    expect(d.querySelector('.math-display')?.textContent?.trim()).toBe('y');
  });

  it('renders GFM tables, footnotes and strikethrough', () => {
    const d = dom(
      renderMarkdown('| a | b |\n|---|---|\n| 1 | ~~2~~ |\n\nText[^1]\n\n[^1]: Note.\n'),
    );
    expect(d.querySelectorAll('table th').length).toBe(2);
    expect(d.querySelector('del')?.textContent).toBe('2');
    expect(d.querySelector('section[data-footnotes], .footnotes')).toBeTruthy();
  });

  it('renders inline footnotes ^[…] numbered with the labelled ones, in reading order', () => {
    const d = dom(
      renderMarkdown(
        'One^[first *inline* with [[Linked]]] two[^x] three^[second [nested] note].\n\n[^x]: Labelled.\n',
      ),
    );
    const refs = [...d.querySelectorAll('sup a[data-footnote-ref], a[data-footnote-ref]')].map(
      (a) => a.textContent,
    );
    expect(refs).toEqual(['1', '2', '3']);
    const items = [...d.querySelectorAll('section[data-footnotes] li')].map((li) =>
      li.textContent?.replace('↩', '').trim(),
    );
    expect(items).toEqual(['first inline with Linked', 'Labelled.', 'second [nested] note']);
    // The content keeps its formatting and its wikilink.
    expect(d.querySelector('section[data-footnotes] em')?.textContent).toBe('inline');
    expect(d.querySelector('section[data-footnotes] a.wikilink')?.getAttribute('data-target')).toBe(
      'Linked',
    );
    expect(d.textContent).not.toContain('^[');
  });

  it('leaves code, escaped and unclosed ^[ as text', () => {
    const d = dom(renderMarkdown('`a ^[b]` and \\^[c] and ^[open\n'));
    expect(d.querySelector('section[data-footnotes]')).toBeNull();
    expect(d.querySelector('code')?.textContent).toBe('a ^[b]');
    expect(d.textContent).toContain('^[c] and ^[open');
  });

  it('sanitizes: no scripts, frames, styles, event handlers or javascript: links', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><iframe src="https://evil"></iframe><style>*{display:none}</style>\n\n<p style="color:red" onclick="x()">hi</p>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)> <b>ok</b>\n',
    );
    expect(html).not.toMatch(/<script|<iframe|<style|onclick|onerror|style=|javascript:/i);
    expect(html).toContain('<b>ok</b>');
  });
});

describe('a leading BOM', () => {
  it('is dropped by prepareSource and never shows in the rendering', () => {
    expect(prepareSource('\uFEFFtext %%c%% more\n')).toBe('text       more\n');
    // one mark, as the indexer takes off: a second one is text, and is not dropped here either
    expect(prepareSource('\uFEFF\uFEFFtext\n')).toBe('\uFEFFtext\n');
    // A guard only: micromark drops a leading BOM by itself, so this holds without prepareSource.
    expect(renderMarkdown('\uFEFFhello\n')).not.toContain('\uFEFF');
  });

  it('does not hide a fence on the first line: its content is code, comments included', () => {
    const src = '\uFEFF```\n%% not a comment %%\n```\n';
    expect(prepareSource(src)).toBe('```\n%% not a comment %%\n```\n');
    const d = dom(renderMarkdown(src));
    expect(d.querySelector('pre code')?.textContent).toBe('%% not a comment %%\n');
    // A guard only (micromark drops the BOM anyway): the discriminating checks are the ones above.
    expect(d.textContent).not.toContain('\uFEFF');
  });

  it('does not hide a frontmatter block on the first line', () => {
    const d = dom(renderMarkdown('\uFEFF---\ntitle: x\n---\n# Body\n'));
    expect(d.querySelector('h1')?.textContent).toBe('Body');
    expect(d.textContent).not.toContain('title');
    expect(d.querySelector('hr')).toBeNull();
  });
});

describe('sections', () => {
  const note =
    '---\na: 1\n---\n# Top\n\nintro\n\n## One\nbody one\nsecond line ^b1\n\n### Deep\ndeep\n\n## Two\nbody two\n\n- item ^li\n';
  it('extracts a heading section including deeper levels', () => {
    expect(extractSection(note, 'One')).toBe('## One\nbody one\nsecond line ^b1\n\n### Deep\ndeep');
    expect(extractSection(note, 'two')?.startsWith('## Two')).toBe(true);
    expect(extractSection(note, 'Missing')).toBeNull();
  });
  it('extracts a block by id without the marker', () => {
    expect(extractBlock(note, 'b1')).toBe('body one\nsecond line');
    expect(extractBlock(note, 'li')).toBe('- item');
    expect(extractBlock(note, 'nope')).toBeNull();
  });
});
