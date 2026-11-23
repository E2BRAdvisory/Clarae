// VitePress configuration of the documentation site: Markdown in docs/, static site in docs_html/,
// ready for GitHub Pages (project site, hence the base path). Build with `task docs-build`.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoUrl = 'https://github.com/E2BRAdvisory/Clarae';
const branch = 'main';
// GitHub Pages serves a project site under /<repository>/: DOCS_BASE overrides it (e.g. "/" for a custom domain).
const base = process.env.DOCS_BASE ?? '/Clarae/';

/** The first H1 of a page, without inline Markdown, as the sidebar label. */
function pageTitle(file) {
  const h1 = readFileSync(join(docsDir, file), 'utf8').match(/^# (.+)$/m)?.[1] ?? file;
  return h1
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}

/** The site route of a Markdown file of docs/ (README.md is the index of its folder). */
function route(file) {
  return '/' + file.replace(/(^|\/)(README|index)\.md$/, '$1').replace(/\.md$/, '');
}

/**
 * The sidebar follows docs/index.md: one group per "##" section, in its order, with the pages it links;
 * the ADR group lists every ADR of docs/adr. A page appears once, in the first group that links it.
 */
function sidebar() {
  const index = readFileSync(join(docsDir, 'index.md'), 'utf8');
  const seen = new Set(['index.md']);
  const groups = [
    {
      text: 'Introduzione',
      items: [
        { text: 'Documentazione', link: '/' },
        { text: pageTitle('roadmap.md'), link: route('roadmap.md') },
      ],
    },
  ];
  seen.add('roadmap.md');
  const skip = new Set(['Fonti di verità', 'Da dove cominciare']);
  for (const section of index.split(/^## /m).slice(1)) {
    const heading = section.slice(0, section.indexOf('\n')).trim();
    if (skip.has(heading)) continue;
    let files = [...section.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)]
      .map((m) => posix.normalize(m[1]))
      .filter((f) => !f.startsWith('..'));
    if (heading.startsWith('Decisioni architetturali')) {
      files = [
        'adr/README.md',
        ...readdirSync(join(docsDir, 'adr'))
          .filter((f) => /^\d{4}-.*\.md$/.test(f) && f !== '0000-template.md')
          .sort()
          .map((f) => `adr/${f}`),
        'adr/0000-template.md',
      ];
    }
    const items = files
      .filter((f) => !seen.has(f) && existsSync(join(docsDir, f)))
      .map((f) => {
        seen.add(f);
        return { text: pageTitle(f), link: route(f) };
      });
    if (items.length > 0) groups.push({ text: heading, collapsed: true, items });
  }
  return groups;
}

/**
 * A relative link to a file that is not a page of the site (a source file, Specifications.md, a JSON
 * or text file next to a page) points to the file on GitHub, so it is not a dead link.
 */
function repoLinks(md) {
  const original =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href');
    if (href && env.relativePath && !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) {
      const [path, hash] = href.split('#');
      const target = posix.normalize(posix.join(posix.dirname(env.relativePath), decodeURI(path)));
      const inside = !target.startsWith('..');
      const isPage =
        inside &&
        (/\.md$/.test(target)
          ? existsSync(join(docsDir, target))
          : existsSync(join(docsDir, target, 'README.md')) ||
            existsSync(join(docsDir, target, 'index.md')));
      if (!isPage) {
        const repoPath = relative(resolve(docsDir, '..'), resolve(docsDir, target))
          .split('\\')
          .join('/');
        const kind = path.endsWith('/') ? 'tree' : 'blob';
        token.attrSet('href', `${repoUrl}/${kind}/${branch}/${repoPath}${hash ? '#' + hash : ''}`);
      } else if (/(^|\/)README\.md$/.test(path)) {
        // The rewrite below turns README.md into index.md, but VitePress does not apply it to links.
        token.attrSet('href', path.replace(/README\.md$/, 'index.md') + (hash ? '#' + hash : ''));
      }
    }
    return original(tokens, idx, options, env, self);
  };
  // Pages are Vue templates: inline code like `{{date}}` must not be read as an interpolation (fenced code
  // blocks already get v-pre from VitePress).
  const codeInline = md.renderer.rules.code_inline;
  md.renderer.rules.code_inline = (tokens, idx, options, env, self) =>
    codeInline(tokens, idx, options, env, self).replace(/^<code/, '<code v-pre');
}

const logo = `data:image/svg+xml;base64,${readFileSync(join(docsDir, '../assets/brand/mark.svg')).toString('base64')}`;
const favicon = `data:image/svg+xml;base64,${readFileSync(join(docsDir, '../assets/brand/icon.svg')).toString('base64')}`;

export default defineConfig({
  lang: 'it-IT',
  title: 'Clarae notanda',
  description:
    'Documentazione di Clarae notanda: knowledge management local-first, desktop e cloud.',
  base,
  outDir: '../docs_html',
  cacheDir: './.vitepress/cache',
  // README.md is the index of its folder, as on GitHub.
  rewrites: { ':path(.*)/README.md': ':path/index.md' },
  // GitHub Pages serves page.html for /page too, but explicit .html links work everywhere.
  cleanUrls: false,
  ignoreDeadLinks: 'localhostLinks',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: favicon }]],
  markdown: {
    config: repoLinks,
  },
  // The local search index (about 2 MB, loaded only when the search opens) is the one large chunk.
  vite: { build: { chunkSizeWarningLimit: 3000 } },
  themeConfig: {
    logo,
    siteTitle: 'Clarae notanda',
    nav: [
      { text: 'Guida utente', link: '/user-guide/' },
      { text: 'Amministrazione', link: '/admin-guide/' },
      { text: 'Architettura', link: '/architecture' },
      { text: 'ADR', link: '/adr/' },
      { text: 'Roadmap', link: '/roadmap' },
    ],
    sidebar: sidebar(),
    socialLinks: [{ icon: 'github', link: repoUrl }],
    editLink: {
      pattern: `${repoUrl}/edit/${branch}/docs/:path`,
      text: 'Modifica questa pagina su GitHub',
    },
    outline: { level: [2, 3], label: 'In questa pagina' },
    docFooter: { prev: 'Pagina precedente', next: 'Pagina successiva' },
    returnToTopLabel: 'Torna su',
    sidebarMenuLabel: 'Menu',
    darkModeSwitchLabel: 'Aspetto',
    lightModeSwitchTitle: 'Passa al tema chiaro',
    darkModeSwitchTitle: 'Passa al tema scuro',
    notFound: {
      title: 'PAGINA NON TROVATA',
      quote: 'La pagina cercata non esiste o è stata spostata.',
      linkLabel: 'Torna alla documentazione',
      linkText: 'Torna alla documentazione',
    },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Cerca', buttonAriaLabel: 'Cerca' },
          modal: {
            displayDetails: 'Mostra dettagli',
            resetButtonTitle: 'Cancella la ricerca',
            backButtonTitle: 'Chiudi la ricerca',
            noResultsText: 'Nessun risultato per',
            footer: { selectText: 'apri', navigateText: 'naviga', closeText: 'chiudi' },
          },
        },
      },
    },
  },
  // Without .nojekyll GitHub Pages runs Jekyll, which drops the files and folders starting with "_".
  buildEnd({ outDir }) {
    writeFileSync(join(outDir, '.nojekyll'), '');
  },
});
