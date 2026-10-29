import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../app/api';
import { commands } from '../commands/registry';
import { initI18n } from '../i18n';
import { useAppStore } from '../state/store';
import { installWailsMock, type WailsMock } from '../test/wails-mock';
import { DialogHost } from '../ui/dialogs';
import { printCss, standaloneCss } from './css';
import { buildHtmlDocument } from './html';
import { exportNoteHtml, exportNotePdf } from './commands';
import { renderExportBody } from './render';
import type { EmbedBackend } from '../embeds/hydrate';

vi.mock('./mermaid', () => ({
  renderMermaidLight: (codes: string[]) =>
    Promise.resolve(
      codes.map((c) => (c.includes('bad') ? null : '<svg><text>diagram</text></svg>')),
    ),
}));

const PNG = btoa('PNGDATA');

const notes: Record<string, string> = {
  'Other.md': '---\nx: 1\n---\n# Other\n\nOther body',
  'Self.md': '![[Self]]',
};
const backend: EmbedBackend = {
  resolve: (_from, target) => {
    const p = /\.\w+$/.test(target) ? target : target + '.md';
    return Promise.resolve(
      p in notes || p === 'pic.png' || p === 'big.png' || p === 'a.mp3' ? p : '',
    );
  },
  readNote: (p) => (p in notes ? Promise.resolve(notes[p] ?? '') : Promise.reject(new Error('nf'))),
  readBinary: (p) =>
    Promise.resolve({
      path: p,
      mime: p.endsWith('.mp3') ? 'audio/mpeg' : 'image/png',
      data: PNG,
      size: p === 'big.png' ? 20 << 20 : 7,
    }),
};
const run = (content: string, over: object = {}) =>
  renderExportBody({ backend, path: 'Host.md', content, ...over });

describe('renderExportBody', () => {
  it('inlines images and embedded notes, keeps the structure', async () => {
    const r = await run('# T\n\n![[pic.png|120]]\n\n![alt](pic.png)\n\n![[Other]]\n');
    const root = document.createElement('div');
    root.innerHTML = r.html;
    expect([...root.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      `data:image/png;base64,${PNG}`,
      `data:image/png;base64,${PNG}`,
    ]);
    expect(root.querySelector('h1')?.id).toBe('t');
    expect(root.querySelector('.embed-note-title')?.textContent).toBe('Other');
    expect(root.querySelector('.embed-note-body')?.textContent).toContain('Other body');
    expect(r.html).not.toContain('x: 1'); // frontmatter of the embedded note
    expect(r.skipped).toEqual([]);
  });

  it('leaves out and reports what cannot be inlined', async () => {
    const r = await run(
      '![[big.png]]\n\n![[a.mp3]]\n\n![remote](https://example.com/x.png)\n\n![[Self]]\n\n![[Missing]]',
    );
    expect(r.skipped).toEqual(['big.png']);
    expect(r.omitted).toEqual(
      expect.arrayContaining(['a.mp3', 'https://example.com/x.png', '![[Missing]]']),
    );
    expect(r.html).not.toContain('example.com');
    expect(r.html).not.toContain('<img');
  });

  it('honours the total size cap', async () => {
    const r = await run('![[pic.png]]\n\n![](pic.png)', { maxTotalBytes: 10 });
    expect(r.skipped).toEqual(['pic.png']);
    expect(r.html.match(/<img/g)).toHaveLength(1);
  });

  it('turns wikilinks into plain text, keeps heading anchors and web links', async () => {
    const r = await run(
      '[[Other]] [[Other|alias]] [[#Part]] [web](https://example.com) [rel](Other.md) #tag\n\n## Part',
    );
    const root = document.createElement('div');
    root.innerHTML = r.html;
    expect([...root.querySelectorAll('span.wikilink')].map((s) => s.textContent)).toEqual([
      'Other',
      'alias',
      'rel',
    ]);
    expect(root.querySelector('a[href="#part"]')?.textContent).toBe('Part');
    expect(root.querySelector('a[href="https://example.com"]')?.getAttribute('rel')).toContain(
      'noopener',
    );
    expect(root.querySelector('span.tag')?.textContent).toBe('#tag');
  });

  it('typesets math as MathML and diagrams as inline SVG; failing diagrams stay as source', async () => {
    const r = await run(
      'Inline $x^2$ and\n\n$$\\frac{a}{b}$$\n\n```mermaid\ngraph TD\n```\n\n```mermaid\nbad\n```',
    );
    const root = document.createElement('div');
    root.innerHTML = r.html;
    expect(root.querySelectorAll('math').length).toBe(2);
    expect(root.querySelector('.katex-html')).toBeNull();
    expect(root.querySelectorAll('.mermaid-diagram svg')).toHaveLength(1);
    expect(root.querySelectorAll('pre > code.language-mermaid')).toHaveLength(1);
  });

  it('marks tasks, opens callouts and strips scripts, styles and handlers', async () => {
    const r = await run(
      '- [ ] todo\n- [x] done\n\n> [!note]- Folded\n> body\n\n<script>alert(1)</script><img src="x" onerror="alert(2)"><div style="color:red">s</div><style>a{}</style>',
    );
    const root = document.createElement('div');
    root.innerHTML = r.html;
    expect([...root.querySelectorAll('.task-mark')].map((m) => m.textContent)).toEqual(['☐', '☑']);
    expect(root.querySelector('details')?.hasAttribute('open')).toBe(true);
    expect(r.html).not.toMatch(/<script|onerror|style=|<style/i);
  });
});

describe('standalone document', () => {
  it('is self-contained: sanitized body, CSP, title, light and dark, no scripts or remote loads', async () => {
    const body = (await run('# Hi\n\n![[pic.png]]\n\n[l](https://example.com)')).html;
    const html = buildHtmlDocument({ title: 'A <b> & "c"', lang: 'it', body });
    expect(html).toContain('<title>A &lt;b&gt; &amp; &quot;c&quot;</title>');
    expect(html).toContain('<html lang="it">');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain("default-src 'none'; img-src data:");
    expect(html).not.toMatch(/<script|<link|@import|url\(|onload=/i);
    expect(html.match(/(src|href)="https?:/g)).toEqual(['href="https:']); // only the visible link
  });

  it('print stylesheet forces light colours and hides the application', () => {
    const css = printCss();
    expect(css).toContain('body.printing > *:not(#memobrain-print)');
    expect(css).toContain('color-scheme: light');
    expect(css).not.toContain('prefers-color-scheme: dark');
    expect(standaloneCss()).toContain('.export-doc h1');
  });
});

describe('export commands', () => {
  let mock: WailsMock;
  beforeEach(async () => {
    initI18n('en');
    mock = installWailsMock();
    const info = await api.vault.open('/vaults/Notes');
    mock.vaults.get(info.id)?.files.set('Home.md', '# Home\n\nHello $x$ and [[Other]]');
    useAppStore.getState().setVault(info);
    useAppStore.getState().openNote('Home.md');
  });
  afterEach(() => {
    document.getElementById('memobrain-print')?.remove();
    document.body.classList.remove('printing');
  });

  it('registers both commands, enabled only with a note open', () => {
    for (const id of ['note:export-pdf', 'note:export-html']) {
      const c = commands.find((x) => x.id === id);
      expect(c?.group).toBe('file');
      expect(c?.enabled?.()).toBe(true);
    }
  });

  it('saves a standalone HTML file through the binding', async () => {
    render(<DialogHost />);
    const done = exportNoteHtml();
    await screen.findByText(/saved to \/mock\/exports\/Home\.html/);
    const saved = mock.htmlExports[0];
    expect(saved?.name).toBe('Home');
    expect(saved?.html).toContain('<h1 id="home">Home</h1>');
    expect(saved?.html).toContain('<math');
    expect(saved?.html).not.toMatch(/<script/i);
    fireEvent.click(screen.getByRole('button', { name: /ok|close/i }));
    await done;
  });

  it('says nothing when the save dialog is cancelled', async () => {
    mock.exportCancelled = true;
    render(<DialogHost />);
    await exportNoteHtml();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.htmlExports).toEqual([]);
  });

  it('prints through a light print layer that carries the rendered note', async () => {
    await exportNotePdf();
    expect(mock.prints).toBe(1);
    const layer = document.getElementById('memobrain-print');
    expect(layer?.querySelector('h1')?.textContent).toBe('Home');
    expect(document.body.classList.contains('printing')).toBe(true);
    expect(document.getElementById('memobrain-print-style')?.textContent).toContain('@media print');
    window.dispatchEvent(new Event('afterprint'));
    expect(document.getElementById('memobrain-print')).toBeNull();
    expect(document.body.classList.contains('printing')).toBe(false);
  });
});
