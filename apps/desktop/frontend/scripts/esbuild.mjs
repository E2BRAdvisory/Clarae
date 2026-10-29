// Build and dev server of the desktop frontend (esbuild). Usage:
//   node scripts/esbuild.mjs build            production bundle in dist/
//   node scripts/esbuild.mjs dev [--port N]   watch + serve dist/ with live reload (Wails dev, Playwright)
//   node scripts/esbuild.mjs preview [--port N]   production bundle in node_modules/.preview/, served as is (Playwright)
// MEMOBRAIN_E2E=1 makes main.tsx install the in-memory Wails mock (Playwright).
import * as esbuild from 'esbuild';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseOptions, copyExcalidrawAssets, graphWorkerEntry } from '@memobrain/workbench/build';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const mode = process.argv[2] ?? 'build';
const dev = mode === 'dev';
// `preview` builds the production bundle somewhere else, so it never touches the embedded dist/.
const dist = join(root, mode === 'preview' ? 'node_modules/.preview' : 'dist');
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 5173;
const e2e = process.env['MEMOBRAIN_E2E'] === '1';

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

const base = baseOptions({ dev });
const options = {
  ...base,
  entryPoints: { main: join(root, 'src/main.tsx') },
  outdir: dist,
  entryNames: dev ? 'assets/[name]' : 'assets/[name]-[hash]',
  chunkNames: dev ? 'assets/[name]-[hash]' : 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/',
  // No source maps in production: dist/ is embedded in the binary (go:embed).
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  metafile: true,
  logLevel: 'info',
  define: { ...base.define, 'import.meta.env.MEMOBRAIN_E2E': JSON.stringify(e2e ? '1' : '') },
  plugins: dev ? [...base.plugins, html, reload] : [...base.plugins, html],
};

// The graph layout runs in a worker: a separate, self-contained bundle at a fixed URL.
const workerOptions = {
  entryPoints: { 'layout.worker': graphWorkerEntry },
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
await copyExcalidrawAssets(dist);

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
