// esbuild pieces shared by every app that hosts the workbench (the desktop frontend today, the Web UI
// in M9-WP5): plugins, loaders and the copies of Excalidraw's assets. Each app keeps its own entry,
// HTML, dev server and bundle budget. Usage: `import { ... } from '@clarae/workbench/build'`.
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of this package. */
export const workbenchRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Dependencies are resolved from the workbench, not from the app that happens to run the build.
const require = createRequire(join(workbenchRoot, 'package.json'));

/**
 * The directory a build writes to (it is emptied first): `CLARAE_DIST` when it is set, else `fallback`. A
 * relative value starts at `root`, the app's package, never at the working directory; an absolute one is taken
 * as it is (so a build can go anywhere, a scratch folder included). The package itself, or a folder that holds
 * it, is refused: the build would delete the sources.
 */
export function distDir(root, fallback, env = process.env['CLARAE_DIST']) {
  const pkg = resolve(root);
  const dist = resolve(pkg, env || fallback);
  if (dist === pkg || pkg.startsWith(dist.endsWith(sep) ? dist : dist + sep)) {
    throw new Error(
      `CLARAE_DIST=${env} is the package or one of its parents: refusing to empty it`,
    );
  }
  return dist;
}

/** The graph layout runs in a worker: a separate, self-contained bundle at a fixed URL. */
export const graphWorkerEntry = join(workbenchRoot, 'src/graph/layout.worker.ts');

/** The tsconfig whose `paths` (the `@/` alias) esbuild applies to the workbench sources. */
export const tsconfig = join(workbenchRoot, 'tsconfig.app.json');

/**
 * `import x from 'pkg/file?url'` yields the URL of the file copied into dist/assets (what the
 * pdf.js worker needs). The file is emitted with esbuild's `file` loader.
 */
export const urlImports = {
  name: 'url-imports',
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, async (args) => {
      const r = await build.resolve(args.path.replace(/\?url$/, ''), {
        resolveDir: args.resolveDir,
        kind: args.kind,
      });
      return r.errors.length ? r : { path: r.path, namespace: 'url-file' };
    });
    build.onLoad({ filter: /.*/, namespace: 'url-file' }, async (args) => ({
      contents: await readFile(args.path),
      loader: 'file',
    }));
  },
};

/**
 * Excalidraw is the zsviczian fork (the one behind the Obsidian plugin: lasso, bucket fill,
 * draw-to-shape). Its only self-contained build is a classic script that reads React, ReactDOM and
 * ReactJSXRuntime from globals and sets ExcalidrawLib. The virtual module below hands it the app's
 * React, loads the script copied into dist/excalidraw-assets (same origin: script-src 'self') and
 * re-exports the library by name, so `import { Excalidraw } from '@excalidraw/excalidraw'` works.
 * `scriptIntegrity` (the Web UI, ADR-0029) adds Subresource Integrity to that script tag: pass the
 * sha384 of the file copyExcalidrawAssets wrote.
 */
const excalidrawDir = join(dirname(require.resolve('@excalidraw/excalidraw')), '..'); // .../dist
const excalidrawExports = JSON.parse(
  await readFile(join(workbenchRoot, 'scripts/excalidraw-exports.json'), 'utf8'),
);
export const excalidrawForkPlugin = ({ scriptIntegrity = '' } = {}) => ({
  name: 'excalidraw-fork',
  setup(build) {
    build.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({
      path: 'excalidraw-fork',
      namespace: 'excalidraw-fork',
    }));
    build.onResolve({ filter: /^@excalidraw\/excalidraw\/index\.css$/ }, () => ({
      path: join(excalidrawDir, 'obsidian/excalidraw.production.min.css'),
    }));
    build.onLoad({ filter: /.*/, namespace: 'excalidraw-fork' }, () => ({
      resolveDir: workbenchRoot,
      loader: 'js',
      contents: `
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactJSXRuntime from 'react/jsx-runtime';
Object.assign(globalThis, { React, ReactDOM: { ...ReactDOM, ...ReactDOMClient }, ReactJSXRuntime });
if (!globalThis.ExcalidrawLib) {
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/excalidraw-assets/excalidraw.js';${
      scriptIntegrity
        ? `\n    s.integrity = ${JSON.stringify(scriptIntegrity)};\n    s.crossOrigin = 'anonymous';`
        : ''
    }
    s.onload = resolve;
    s.onerror = () => reject(new Error('cannot load excalidraw.js'));
    document.head.append(s);
  });
}
const lib = globalThis.ExcalidrawLib;
${excalidrawExports.map((k) => `export const ${k} = lib.${k};`).join('\n')}
`,
    }));
  },
});
export const excalidrawFork = excalidrawForkPlugin();

/**
 * Excalidraw loads its fonts at run time from window.EXCALIDRAW_ASSET_PATH. Serving them from the
 * app itself keeps the editor working offline (no CDN request, see drawing/assets.ts).
 */
export async function copyExcalidrawAssets(dist) {
  const dir = dirname(require.resolve('@excalidraw/excalidraw')); // .../dist/prod
  await cp(join(dir, 'fonts'), join(dist, 'excalidraw-assets', 'fonts'), { recursive: true });
  const script = await readFile(
    join(excalidrawDir, 'obsidian/excalidraw.production.min.js'),
    'utf8',
  );
  await writeFile(join(dist, 'excalidraw-assets', 'excalidraw.js'), withoutCdnFallback(script));
}

// Excalidraw lists a CDN (esm.sh) after EXCALIDRAW_ASSET_PATH as the source of every font face, and
// the browser goes there for faces it does not take from the first source: the CJK fallback Xiaolai
// did, on every drawing with text (blocked by the CSP, so it never rendered). The fallback is pointed
// at the fonts the app serves, so no font can come from outside (spec §2.7.3, V-08 offline).
const CDN_FALLBACK =
  /`https:\/\/esm\.sh\/\$\{(\w+)\.PKG_NAME\?`\$\{\1\.PKG_NAME\}@\$\{\1\.PKG_VERSION\}`:"@excalidraw\/excalidraw"\}\/dist\/prod\/`/g;

export function withoutCdnFallback(script) {
  const found = script.match(CDN_FALLBACK)?.length ?? 0;
  if (found !== 1 || /https:\/\/esm\.sh\//.test(script.replace(CDN_FALLBACK, ''))) {
    throw new Error(
      `excalidraw.js: expected exactly one esm.sh font fallback, found ${found}: update withoutCdnFallback for this Excalidraw version`,
    );
  }
  return script.replace(CDN_FALLBACK, '`${location.origin}/excalidraw-assets/`');
}

/**
 * The collaboration chunk (ADR-0050, A-D12) exists only in a build made for it (`CLARAE_COLLAB=1`):
 * in every other one `live/chunks/collab.ts` is replaced by a stub, so that Yjs, y-prosemirror and the
 * plugin are in no file of a released build, however a profile is set. The gate of the editor refuses
 * first (build constant, flag, provider); this keeps the code out as well. The stub throws if it is ever
 * called, which the gate does not allow.
 */
export const liveCollab = (enabled) => ({
  name: 'live-collab',
  setup(build) {
    if (enabled) return;
    build.onLoad({ filter: /live[\\/]chunks[\\/]collab\.ts$/ }, () => ({
      loader: 'js',
      contents: [
        `const off = () => { throw new Error('collaboration is not in this build'); };`,
        `export const collab = off;`,
        `export const collabServiceCtx = undefined;`,
        `export const startCollab = () => Promise.reject(new Error('collaboration is not in this build'));`,
      ].join('\n'),
    }));
  },
});

/**
 * The Twemoji images of the Live editor (A-W4): the `<img>` of an emoji points at `/emoji/svg/<code>.svg`
 * (live/chunks/emoji.ts), so that no request leaves the application (spec §2.7.3, V-08 offline) and
 * `img-src 'self'` is enough. Every build copies them, as it does the fonts of Excalidraw; they are no
 * output of esbuild: the bundle budget (ADR-0020) counts the code, not them.
 *
 * The graphics are Twemoji by Twitter, Inc. and other contributors, licensed CC-BY 4.0 (the code of the
 * library is MIT); the files come from `@discordapp/twemoji`, the release of the project's set that ships
 * the SVGs (the `twemoji` package has none), with the same Unicode version as the parser the editor
 * uses. CC-BY 4.0 asks for attribution. Where it is: in `emoji/ATTRIBUTION.txt`, written by this
 * function next to the images (with the licence of the package), and in the About section of the settings (`settings.twemojiAttribution`).
 * The comment of live/chunks/emoji.ts repeats it in the source only: esbuild's minification drops it, so
 * the JS the build ships carries no attribution.
 */
export async function copyTwemojiAssets(dist) {
  const pkg = dirname(require.resolve('@discordapp/twemoji/package.json'));
  const out = join(dist, 'emoji');
  await cp(join(pkg, 'dist/svg'), join(out, 'svg'), { recursive: true });
  const { version } = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
  const licence = await readFile(join(pkg, 'LICENSE'), 'utf8');
  await writeFile(
    join(out, 'ATTRIBUTION.txt'),
    `Twemoji ${version} graphics: Copyright Twitter, Inc. and other contributors.\n` +
      `Licensed under CC-BY 4.0: https://creativecommons.org/licenses/by/4.0/\n` +
      `Twemoji: https://github.com/twitter/twemoji, maintained at https://github.com/jdecked/twemoji.\n` +
      `The SVG files are the ones of the npm package @discordapp/twemoji, copied unmodified.\n\n` +
      `The code of the project is licensed under the MIT License:\n\n${licence}`,
  );
}

/**
 * A style sheet that a lazy chunk imports (Milkdown's, Excalidraw's, a view's) is a file of its own that
 * esbuild writes next to the chunk and links to nothing: the page's <link> is only the entry's. This puts
 * the link where the chunk needs it: the chunk waits, before it runs, for the sheets it imports (a
 * top-level await in a module that is only ever imported dynamically), and takes them only once. A sheet
 * whose files the page's own sheet already has is not
 * linked at all. Returns the sheets it linked and the ones it left out.
 *
 * `integrity(bytes)` gives the Subresource Integrity value of a sheet for builds that pin their files
 * (the Web UI); the sheets are final when this runs, so the web build calls `linkLazyStyles` itself, first
 * thing in the step that hashes the chunks. `root` is where the metafile paths start, `dist` where the
 * files are served from, `entries` the entry points of the pages (`src/main.tsx`): their sheets are linked
 * by the page.
 *
 * `root` is also esbuild's working directory: the metafile paths are relative to it, so the build passes
 * `absWorkingDir: root` and the result no longer depends on where the script is run from.
 *
 * Today it links nothing (every sheet a lazy chunk imports is already in the page's: 9 left out). It stays
 * as a safety net for the day a chunk brings a sheet of its own, which would otherwise be written and never loaded.
 */
export async function linkLazyStyles(metafile, { root, dist, entries, integrity = () => '' }) {
  const linked = [];
  const skipped = [];
  // esbuild gives every chunk that is loaded with import() (it counts them as entry points) the style
  // sheet of what it imports as its `cssBundle`; the one of a page's own entry is the one the page links
  for (const [chunk, o] of Object.entries(metafile.outputs)) {
    if (!chunk.endsWith('.js') || !o.cssBundle || entries.includes(o.entryPoint)) continue;
    const sheet = o.cssBundle;
    if (inPages(metafile, entries, chunk, sheet)) {
      skipped.push(sheet);
      continue;
    }
    linked.push(sheet);
    const link = {
      url: '/' + relative(dist, join(root, sheet)).replaceAll('\\', '/'),
      integrity: integrity(await readFile(join(root, sheet))),
    };
    const file = join(root, chunk);
    const loader =
      `await new Promise((done) => {` +
      `const s = ${JSON.stringify(link)};` +
      `if (document.querySelector('link[rel=stylesheet]' + '[href="' + s.url + '"]')) return done();` +
      `const l = document.createElement('link');l.rel = 'stylesheet';l.href = s.url;` +
      `if (s.integrity) { l.integrity = s.integrity; l.crossOrigin = 'anonymous'; }` +
      `l.onload = l.onerror = () => done();document.head.append(l);}); \n`;
    await writeFile(file, loader + (await readFile(file, 'utf8')));
  }
  return { linked, skipped };
}

/**
 * True when every style file of the sheet of a lazy chunk is already in the sheet of each page that can
 * reach the chunk: linking it would download and parse the same rules again, and the second copy, last
 * in the cascade, could win over what the page has had in order. (A sheet with some files the page does
 * not have is linked whole: esbuild gives no way to cut it.)
 */
function inPages(metafile, entries, chunk, sheet) {
  const { outputs } = metafile;
  const reached = pagesOf(metafile, entries).filter(({ reach }) => reach.has(chunk));
  if (!reached.length) return false;
  const files = Object.keys(outputs[sheet].inputs);
  return reached.every(({ page }) => {
    const css = outputs[page].cssBundle;
    const have = css ? outputs[css]?.inputs : undefined;
    return !!have && files.every((f) => f in have);
  });
}

const pagesCache = new WeakMap();
/** The pages (the entry outputs) with every file each of them can reach, by static import or import(). */
function pagesOf(metafile, entries) {
  let pages = pagesCache.get(metafile);
  if (pages) return pages;
  const { outputs } = metafile;
  pages = Object.entries(outputs)
    .filter(([, o]) => entries.includes(o.entryPoint))
    .map(([page]) => {
      const reach = new Set();
      const walk = (file) => {
        if (reach.has(file) || !outputs[file]) return;
        reach.add(file);
        for (const i of outputs[file].imports) walk(i.path);
      };
      walk(page);
      return { page, reach };
    });
  pagesCache.set(metafile, pages);
  return pages;
}

/** `linkLazyStyles` at the end of every build (the desktop's: no file of it is pinned). */
export const lazyStyles = (options) => ({
  name: 'lazy-styles',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length || !result.metafile) return;
      const { linked, skipped } = await linkLazyStyles(result.metafile, options);
      const kb = (sheets) =>
        (sheets.reduce((n, f) => n + result.metafile.outputs[f].bytes, 0) / 1024).toFixed(1);
      console.log(
        `Lazy style sheets: ${linked.length} linked (${kb(linked)} kB), ${skipped.length} already in the page's sheet (${kb(skipped)} kB)`,
      );
    });
  },
});

/** Build options that do not depend on the app: bundle, target, loaders, aliases. */
export function baseOptions({ dev }) {
  return {
    bundle: true,
    splitting: true,
    format: 'esm',
    target: ['es2022', 'chrome100', 'safari15'],
    tsconfig,
    conditions: [dev ? 'development' : 'production'],
    // One KaTeX for the whole app: mermaid and Excalidraw each depend on their own copy.
    alias: { katex: dirname(require.resolve('katex/package.json')) },
    legalComments: 'none',
    loader: {
      '.woff': 'file',
      '.woff2': 'file',
      '.ttf': 'file',
      '.svg': 'file',
      '.png': 'file',
      '.wasm': 'file',
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    },
    plugins: [urlImports, excalidrawFork],
  };
}
