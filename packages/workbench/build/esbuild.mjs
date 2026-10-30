// esbuild pieces shared by every app that hosts the workbench (the desktop frontend today, the Web UI
// in M9-WP5): plugins, loaders and the copies of Excalidraw's assets. Each app keeps its own entry,
// HTML, dev server and bundle budget. Usage: `import { ... } from '@memobrain/workbench/build'`.
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of this package. */
export const workbenchRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// Dependencies are resolved from the workbench, not from the app that happens to run the build.
const require = createRequire(join(workbenchRoot, 'package.json'));

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
 */
const excalidrawDir = join(dirname(require.resolve('@excalidraw/excalidraw')), '..'); // .../dist
const excalidrawExports = JSON.parse(
  await readFile(join(workbenchRoot, 'scripts/excalidraw-exports.json'), 'utf8'),
);
export const excalidrawFork = {
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
    s.src = '/excalidraw-assets/excalidraw.js';
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
};

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
