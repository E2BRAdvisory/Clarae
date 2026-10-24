import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './render';
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

  it('sanitizes: no scripts, frames, styles, event handlers or javascript: links', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script><iframe src="https://evil"></iframe><style>*{display:none}</style>\n\n<p style="color:red" onclick="x()">hi</p>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)> <b>ok</b>\n',
    );
    expect(html).not.toMatch(/<script|<iframe|<style|onclick|onerror|style=|javascript:/i);
    expect(html).toContain('<b>ok</b>');
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
