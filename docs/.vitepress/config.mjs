// VitePress configuration of the documentation site: the user guide, the admin guide and the security documents of
// docs/, with site-home.md as the home page, built into docs_html/ for GitHub Pages (project site, hence the base
// path). The other documents of docs/ stay in the repository: links to them point to GitHub. Build with
// `task docs-build`.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoUrl = 'https://github.com/E2BRAdvisory/Clarae';
const branch = 'main';
// GitHub Pages serves a project site under /<repository>/: DOCS_BASE overrides it (e.g. "/" for a custom domain).
const base = process.env.DOCS_BASE ?? '/Clarae/';

// The folders of docs/ published on the site (ADR-0067); everything else in docs/ is left out.
const sections = ['user-guide', 'admin-guide', 'security'];
// The home page of the site (rewritten to index.md): docs/index.md is the index of the whole repository.
const home = 'site-home.md';

/** Whether a Markdown file of docs/ (a path relative to docs/, with "/") is a page of the site. */
function published(file) {
  return file === home || sections.some((s) => file.startsWith(`${s}/`));
}

/** Every top-level entry of docs/ that is not published, as srcExclude globs: new documents stay out by default. */
function excluded() {
  return readdirSync(docsDir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !sections.includes(e.name) && e.name !== home)
    .filter((e) => e.isDirectory() || e.name.endsWith('.md'))
    .map((e) => (e.isDirectory() ? `${e.name}/**` : e.name));
}

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
 * The sidebar follows docs/index.md: one group per "##" section, in its order, with the published pages it links
 * (sections without any are left out). A page appears once, in the first group that links it.
 */
function sidebar() {
  const index = readFileSync(join(docsDir, 'index.md'), 'utf8');
  const seen = new Set();
  const groups = [{ text: 'Introduzione', items: [{ text: 'Documentazione', link: '/' }] }];
  const skip = new Set(['Fonti di verità', 'Da dove cominciare']);
  for (const section of index.split(/^## /m).slice(1)) {
    const heading = section.slice(0, section.indexOf('\n')).trim();
    if (skip.has(heading)) continue;
    const files = [...section.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)]
      .map((m) => posix.normalize(m[1]))
      .filter((f) => !f.startsWith('..'));
    const items = files
      .filter((f) => published(f) && !seen.has(f) && existsSync(join(docsDir, f)))
      .map((f) => {
        seen.add(f);
        return { text: pageTitle(f), link: route(f) };
      });
    if (items.length > 0) groups.push({ text: heading, collapsed: true, items });
  }
  return groups;
}

/**
 * A relative link to a file that is not a page of the site (a document of docs/ left out of the site, a source
 * file, Specifications.md, a JSON or text file next to a page) points to the file on GitHub, so it is not a dead link.
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
      const page = /\.md$/.test(target)
        ? target
        : ['README.md', 'index.md']
            .map((f) => posix.join(target, f))
            .find((f) => existsSync(join(docsDir, f)));
      const isPage =
        inside && page !== undefined && published(page) && existsSync(join(docsDir, page));
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
  srcExclude: excluded(),
  // README.md is the index of its folder, as on GitHub; site-home.md is the home page.
  rewrites: { [home]: 'index.md', ':path(.*)/README.md': ':path/index.md' },
  // GitHub Pages serves page.html for /page too, but explicit .html links work everywhere.
  cleanUrls: false,
  ignoreDeadLinks: 'localhostLinks',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: favicon }]],
  markdown: {
    config: repoLinks,
  },
  // The local search index (loaded only when the search opens) is the one large chunk.
  vite: { build: { chunkSizeWarningLimit: 3000 } },
  themeConfig: {
    logo,
    siteTitle: 'Clarae notanda',
    nav: [
      { text: 'Guida utente', link: '/user-guide/' },
      { text: 'Amministrazione', link: '/admin-guide/' },
      { text: 'Sicurezza', link: '/security/crypto-design' },
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
