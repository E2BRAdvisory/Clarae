import { describe, expect, it } from 'vitest';
import { embedsToImages, renderDeck, slideAt, type AssetResolver } from './engine';
import { safeStyle, sanitizeMarpCss } from './sanitize';

const vault: AssetResolver = (ref) =>
  Promise.resolve(ref === 'img/photo.png' ? { url: 'blob:photo' } : null);

const DECK = `---
marp: true
theme: gaia
paginate: true
---

# Quarterly review

![w:200](img/photo.png)

---

![bg](img/photo.png)

## Roadmap $x^2$ :smile:
`;

describe('Marp rendering', () => {
  it('renders one SVG per slide and tells where each one starts', async () => {
    const deck = await renderDeck(DECK, vault);
    const doc = new DOMParser().parseFromString(deck.html, 'text/html');
    expect(doc.querySelectorAll('div.marpit > svg')).toHaveLength(2);
    expect(deck.slideLines).toEqual([0, 10]); // the second starts at its `---`
    expect(deck.html).toContain('Quarterly review');
    expect(deck.css).toContain('div.marpit');
  });

  it('reports the presenter notes and the slides that are left out', async () => {
    const deck = await renderDeck(
      '# A\n\n<!-- _class: lead -->\n<!-- say hi -->\n\n---\n\n# B\n\n<!-- clarae: hidden -->\n',
      vault,
    );
    expect(deck.notes).toEqual(['say hi', '']);
    expect(deck.hidden).toEqual([false, true]);
  });

  it('leaves out a slide marked by 1.x, and keeps the marker out of the notes', async () => {
    const deck = await renderDeck(
      '# A\n\n<!-- memobrain: hidden -->\n<!-- say hi -->\n\n---\n\n# B\n',
      vault,
    );
    expect(deck.hidden).toEqual([true, false]);
    expect(deck.notes).toEqual(['say hi', '']);
  });

  it('shows the pictures of the vault and nothing from the network', async () => {
    const deck = await renderDeck(
      `${DECK}\n---\n\n![](https://example.com/x.png)\n\n![bg](https://example.com/y.png)\n`,
      vault,
    );
    expect(deck.html).toContain('src="blob:photo"');
    expect(deck.html).toContain('url(&quot;blob:photo&quot;)');
    expect(deck.html).not.toContain('example.com');
  });

  it('keeps math and emoji offline', async () => {
    const deck = await renderDeck(DECK, vault);
    expect(deck.html).toContain('class="katex"');
    expect(deck.html).toContain('😄');
    expect(deck.html).not.toMatch(/twemoji|cdn\.jsdelivr/);
    expect(deck.css).not.toMatch(/@import|@font-face|fonts\.bunny|https?:/);
  });

  it("leaves the author's CSS and HTML out (V-02)", async () => {
    const deck = await renderDeck(
      `---\nmarp: true\nstyle: section { background: red }\n---\n\n<style>section{color:blue}</style>\n<style scoped>h1{color:pink}</style>\n<!-- style: h1 { color: green } -->\n<script>alert(1)</script>\n<img src="x" onerror="alert(1)">\n\n# Title\n`,
      vault,
    );
    expect(deck.css).not.toMatch(/color:\s*blue|pink|color:\s*green|background:\s*red/);
    const doc = new DOMParser().parseFromString(deck.html, 'text/html');
    expect(doc.querySelectorAll('script, style, [onerror], [data-style]')).toHaveLength(0);
    expect(doc.body.textContent).toContain('<script>alert(1)</script>'); // shown as text, inert
  });

  it('turns Obsidian embeds of pictures into Marp images', () => {
    expect(embedsToImages('![[a b.png]] ![[c.png|200]] ![[d.png|20x30]]')).toBe(
      '![](<a b.png>) ![w:200](<c.png>) ![w:20 h:30](<d.png>)',
    );
  });

  it('finds the slide of a line', () => {
    expect(slideAt([0, 9, 20], 0)).toBe(0);
    expect(slideAt([0, 9, 20], 9)).toBe(1);
    expect(slideAt([0, 9, 20], 19)).toBe(1);
    expect(slideAt([0, 9, 20], 400)).toBe(2);
  });
});

describe('Marp sanitizing', () => {
  it('keeps the layout of a slide and drops what could leave it or load a resource', () => {
    expect(safeStyle('background-color:#fff;background-image:url("blob:a")')).toBe(
      'background-color:#fff;background-image:url("blob:a")',
    );
    expect(safeStyle('background-image:url("data:image/png;base64,AAA=");width:10px')).toBe(
      'background-image:url("data:image/png;base64,AAA=");width:10px',
    );
    expect(safeStyle('position:fixed;top:0;z-index:9;color:red')).toBe('top:0;color:red');
    expect(safeStyle('background:url(https://x.test/a.png)')).toBe('');
    expect(safeStyle('--style:h1{color:red};color:red')).toBe('color:red');
  });

  it('removes imports, fonts and remote URLs from the theme', () => {
    const css = sanitizeMarpCss(
      '@import "https://fonts.bunny.net/css";@font-face{font-family:K;src:url(fonts/k.woff2)}a{background:url(x.png)}b{background:url(data:image/png;base64,A)}',
    );
    expect(css).toBe('a{background:none}b{background:url(data:image/png;base64,A)}');
  });
});
