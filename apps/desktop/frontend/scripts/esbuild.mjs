// Build and dev server of the desktop frontend (esbuild). Usage:
//   node scripts/esbuild.mjs build            production bundle in dist/
//   node scripts/esbuild.mjs dev [--port N]   watch + serve dist/ with live reload (Wails dev, Playwright)
//   node scripts/esbuild.mjs preview [--port N]   production bundle in node_modules/.preview/, served as is (Playwright)
// MEMOBRAIN_E2E=1 makes main.tsx install the in-memory Wails mock (Playwright).
import * as esbuild from 'esbuild';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const mode = process.argv[2] ?? 'build';
const dev = mode === 'dev';
// `preview` builds the production bundle somewhere else, so it never touches the embedded dist/.
const dist = join(root, mode === 'preview' ? 'node_modules/.preview' : 'dist');
const require = createRequire(import.meta.url);
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 5173;
const e2e = process.env['MEMOBRAIN_E2E'] === '1';

/**
 * `import x from 'pkg/file?url'` yields the URL of the file copied into dist/assets (what the
 * pdf.js worker needs). The file is emitted with esbuild's `file` loader.
 */
const urlImports = {
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
  await readFile(join(root, 'scripts/excalidraw-exports.json'), 'utf8'),
);
const excalidrawFork = {
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
      resolveDir: root,
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

/** Writes dist/index.html with the hashed bundle and stylesheet, and copies Excalidraw's fonts. */
const html = {
  name: 'index-html',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length || !result.metafile) return;
      const out = Object.entries(result.metafile.outputs).find(
        ([, o]) => o.entryPoint === 'src/main.tsx',
      );
      if (!out) return;
      const [file, meta] = out;
      const url = (p) => '/' + relative(dist, join(root, p)).replaceAll('\\', '/');
      const css = meta.cssBundle
        ? `    <link rel="stylesheet" href="${url(meta.cssBundle)}" />\n  `
        : '';
      const reload = dev ? '\n    <script src="/dev-reload.js"></script>' : '';
      const page = (await readFile(join(root, 'index.html'), 'utf8'))
        .replace('</head>', `${css}</head>`)
        .replace(
          /<script[^>]*src="\.\/src\/main\.tsx"[^>]*><\/script>/,
          `<script type="module" src="${url(file)}"></script>${reload}`,
        );
      await writeFile(join(dist, 'index.html'), page);
    });
  },
};

/** Tells the open pages to reload after each successful rebuild (dev only). */
const clients = new Set();
const reload = {
  name: 'reload',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      for (const res of clients) res.write('event: change\ndata: {}\n\n');
    });
  },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

/**
 * Static server for dist/. esbuild's own server refuses Host headers other than localhost/IPs, and
 * Wails proxies the app as "wails.localhost".
 */
function serve(port) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (path === '/esbuild') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    let file = normalize(join(dist, path === '/' ? 'index.html' : path));
    try {
      if (!file.startsWith(dist) || !(await stat(file)).isFile()) throw new Error('not a file');
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const options = {
  entryPoints: { main: join(root, 'src/main.tsx') },
  outdir: dist,
  entryNames: dev ? 'assets/[name]' : 'assets/[name]-[hash]',
  chunkNames: dev ? 'assets/[name]-[hash]' : 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/',
  bundle: true,
  splitting: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'safari15'],
  tsconfig: join(root, 'tsconfig.app.json'),
  // No source maps in production: dist/ is embedded in the binary (go:embed).
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  conditions: [dev ? 'development' : 'production'],
  metafile: true,
  // One KaTeX for the whole app: mermaid and Excalidraw each depend on their own copy.
  alias: { katex: dirname(require.resolve('katex/package.json')) },
  legalComments: 'none',
  logLevel: 'info',
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
    'import.meta.env.MEMOBRAIN_E2E': JSON.stringify(e2e ? '1' : ''),
  },
  plugins: dev ? [urlImports, excalidrawFork, html, reload] : [urlImports, excalidrawFork, html],
};

// The graph layout runs in a worker: a separate, self-contained bundle at a fixed URL.
const workerOptions = {
  entryPoints: { 'layout.worker': join(root, 'src/graph/layout.worker.ts') },
  outdir: join(dist, 'assets'),
  bundle: true,
  format: 'esm',
  target: options.target,
  tsconfig: options.tsconfig,
  conditions: options.conditions,
  sourcemap: options.sourcemap,
  minify: options.minify,
  logLevel: 'info',
};

/**
 * Excalidraw loads its fonts at run time from window.EXCALIDRAW_ASSET_PATH. Serving them from the
 * app itself keeps the editor working offline (no CDN request, see drawing/assets.ts).
 */
async function copyExcalidrawFonts() {
  const dir = dirname(require.resolve('@excalidraw/excalidraw')); // .../dist/prod
  await cp(join(dir, 'fonts'), join(dist, 'excalidraw-assets', 'fonts'), { recursive: true });
  await cp(
    join(excalidrawDir, 'obsidian/excalidraw.production.min.js'),
    join(dist, 'excalidraw-assets', 'excalidraw.js'),
  );
}

/**
 * Bundle budget (ADR-0020): what the app loads at start (the entry and its static imports) and
 * everything the build emits except the copied Excalidraw fonts. Raise a limit only on purpose.
 */
const BUDGET = { initialKB: 2000, totalKB: 23000 };

function checkBudget(meta) {
  const outputs = meta.outputs;
  const entry = Object.entries(outputs).find(([, o]) => o.entryPoint === 'src/main.tsx')?.[0];
  const seen = new Set();
  const walk = (file) => {
    if (!file || seen.has(file) || !outputs[file]) return;
    seen.add(file);
    for (const i of outputs[file].imports) if (i.kind === 'import-statement') walk(i.path);
  };
  walk(entry);
  const kb = (n) => Math.round(n / 1024);
  const initial = kb([...seen].reduce((n, f) => n + (outputs[f]?.bytes ?? 0), 0));
  const total = kb(Object.values(outputs).reduce((n, o) => n + o.bytes, 0));
  console.log(
    `Bundle: initial ${initial} kB (limit ${BUDGET.initialKB}), total ${total} kB (limit ${BUDGET.totalKB})`,
  );
  if (initial > BUDGET.initialKB || total > BUDGET.totalKB) {
    console.error('Bundle budget exceeded (see ADR-0020).');
    process.exit(1);
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyExcalidrawFonts();

if (dev) {
  await writeFile(
    join(dist, 'dev-reload.js'),
    "new EventSource('/esbuild').addEventListener('change', () => location.reload());\n",
  );
  const app = await esbuild.context(options);
  const worker = await esbuild.context(workerOptions);
  await app.watch();
  await worker.watch();
  await serve(port);
  console.log(`Local: http://127.0.0.1:${port}/`);
} else {
  const result = await esbuild.build(options);
  await esbuild.build(workerOptions);
  checkBudget(result.metafile);
  if (mode === 'preview') {
    await serve(port);
    console.log(`Local: http://127.0.0.1:${port}/`);
  }
}
