// Build and dev server of the Web UI (esbuild). Usage:
//   node scripts/esbuild.mjs build            production bundle in dist/ (embedded by the cloud binary)
//   node scripts/esbuild.mjs dev [--port N]   watch + serve dist/ with live reload, proxying /api to the cloud
// MEMOBRAIN_E2E=1 makes main.tsx install the OIDC test double (Playwright); it is compiled out otherwise.
//
// Two pages are built: the console (index.html) and the vault workbench (workbench.html, served for
// /vaults/:id/open). The workbench is a page of its own so that the desktop UI's global style sheet
// cannot reach the console (ADR-0029). It also needs the WebAssembly core, which `task wasm-core`
// produces in build/wasm/ (MEMOBRAIN_CORE_WASM overrides the path).
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { dirname, extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { baseOptions, copyExcalidrawAssets, graphWorkerEntry } from '@memobrain/workbench/build';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
// MEMOBRAIN_DIST builds elsewhere (the browser test of the production handler uses an E2E build of its own).
const dist = join(root, process.env['MEMOBRAIN_DIST'] ?? 'dist');
const mode = process.argv[2] ?? 'build';
const dev = mode === 'dev';
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 5174;
const apiTarget = new URL(process.env['MEMOBRAIN_API'] ?? 'http://127.0.0.1:18081');
const e2e = process.env['MEMOBRAIN_E2E'] === '1';
const version = process.env['MEMOBRAIN_VERSION'] ?? 'dev';

/** The pages of the app: each has an HTML template and the entry point it loads. */
const PAGES = [
  { entry: 'src/main.tsx', template: 'index.html', out: 'index.html' },
  { entry: 'src/workbench/main.tsx', template: 'workbench.html', out: 'workbench.html' },
];

const sha = (algo, bytes, enc) => createHash(algo).update(bytes).digest(enc);

/**
 * Writes the HTML pages with their hashed bundle and stylesheet. In production it also adds
 * Subresource Integrity (`integrity` + `crossorigin`, sha384) hashing the exact bytes written to
 * dist/: the cloud binary serves them behind a strict CSP with no inline script or style
 * (docs/web-ui.md).
 */
const html = {
  name: 'index-html',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length || !result.metafile) return;
      const url = (p) => '/' + relative(dist, join(root, p)).replaceAll('\\', '/');
      const sri = async (p) => {
        if (dev) return '';
        const digest = sha('sha384', await readFile(join(root, p)), 'base64');
        return ` crossorigin integrity="sha384-${digest}"`;
      };
      for (const page of PAGES) {
        const out = Object.entries(result.metafile.outputs).find(
          ([, o]) => o.entryPoint === page.entry,
        );
        if (!out) continue;
        const [file, meta] = out;
        const css = meta.cssBundle
          ? `    <link rel="stylesheet" href="${url(meta.cssBundle)}"${await sri(meta.cssBundle)} />\n  `
          : '';
        const reload = dev ? '\n    <script src="/dev-reload.js"></script>' : '';
        const script = new RegExp(
          `<script[^>]*src="/${page.entry.replaceAll('.', '\\.')}"[^>]*></script>`,
        );
        const text = (await readFile(join(root, page.template), 'utf8'))
          .replace('</head>', `${css}</head>`)
          .replace(
            script,
            `<script type="module" src="${url(file)}"${await sri(file)}></script>${reload}`,
          );
        await writeFile(join(dist, page.out), text);
      }
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
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/vnd.microsoft.icon',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

/** The vault workbench lives at /vaults/:id/open; everything else under /vaults is the console. */
const isWorkbenchRoute = (path) => /^\/vaults\/[^/]+\/open\/?$/.test(path);

/** Static server for dist/ with the SPA fallback and a proxy of /api to the cloud. */
function serve(port) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (path.startsWith('/api/')) {
      const upstream = request(
        {
          host: apiTarget.hostname,
          port: apiTarget.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      upstream.on('error', () => res.writeHead(502).end('cloud service unreachable'));
      req.pipe(upstream);
      return;
    }
    if (path === '/esbuild') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    let file = normalize(join(dist, path === '/' ? 'index.html' : path));
    try {
      if (!file.startsWith(dist)) throw new Error('outside dist');
      if (!(await stat(file)).isFile()) throw new Error('not a file');
    } catch {
      // Client-side routes (react-router) fall back to the app shell; missing assets stay 404.
      if (extname(path)) {
        res.writeHead(404).end('not found');
        return;
      }
      file = join(dist, isWorkbenchRoute(path) ? 'workbench.html' : 'index.html');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/**
 * Copies the two WebAssembly files of the workbench into dist/core/ under names that carry their hash,
 * and returns what the page needs to fetch them: URL and Subresource Integrity (sha384 of the bytes the
 * page receives, i.e. after decompression). Production keeps only a gzip copy, which the cloud binary
 * serves as is to browsers that accept it (and decompresses for the rest): the core is 36 MB raw.
 * Without the core (it needs the Go toolchain) the workbench page says so instead of failing.
 */
async function prepareCore() {
  const corePath =
    process.env['MEMOBRAIN_CORE_WASM'] ?? join(root, '../build/wasm/memobrain-core.wasm');
  const sqlitePath = join(
    dirname(fileURLToPath(import.meta.resolve('@sqlite.org/sqlite-wasm'))),
    'sqlite3.wasm',
  );
  if (!existsSync(corePath)) {
    console.warn(
      `The WebAssembly core is missing (${corePath}): the vault workbench will not run. Build it with: task wasm-core`,
    );
    return { assets: null, sizes: null };
  }
  await mkdir(join(dist, 'core'), { recursive: true });
  const sizes = {};
  const assets = {};
  for (const [key, name, file] of [
    ['core', 'memobrain-core', corePath],
    ['sqlite', 'sqlite3', sqlitePath],
  ]) {
    const bytes = await readFile(file);
    const fileName = `${name}-${sha('sha256', bytes, 'hex').slice(0, 12)}.wasm`;
    if (dev) await writeFile(join(dist, 'core', fileName), bytes);
    else await writeFile(join(dist, 'core', `${fileName}.gz`), gzipSync(bytes, { level: 9 }));
    sizes[key] = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
    assets[key] = {
      url: `/core/${fileName}`,
      integrity: `sha384-${sha('sha384', bytes, 'base64')}`,
    };
  }
  return { assets, sizes };
}

/** The worker that runs the core is a separate, self-contained bundle: its URL is known to the page. */
async function buildWorker(shared) {
  const result = await esbuild.build({
    ...shared,
    entryPoints: { 'core-worker': join(root, 'src/workbench/worker.ts') },
    outdir: join(dist, 'assets'),
    entryNames: dev ? '[name]' : '[name]-[hash]',
    splitting: false,
    metafile: true,
    plugins: [],
    logLevel: 'warning',
  });
  const out = Object.keys(result.metafile.outputs).find((o) => o.endsWith('.js'));
  return {
    url: '/' + relative(dist, join(root, out)).replaceAll('\\', '/'),
    metafile: result.metafile,
  };
}

/**
 * Bundle budgets (ADR-0020, revised for the workbench): the console keeps its small budget, the
 * workbench follows the desktop's. A part is measured over what its entry can reach, so the console is
 * not charged for what only the workbench loads. The WebAssembly files have their own limits.
 */
const BUDGET = {
  console: { initialKB: 700, totalKB: 1000 },
  // The desktop's limit (2000 kB of script) plus what only the web page loads: the OIDC client, the
  // worker bridge and the style sheet (about 370 kB, which the desktop budget does not count).
  workbench: { initialKB: 2500, totalKB: 23000 },
  wasmGzipKB: { core: 8192, sqlite: 1536 },
};

function reach(outputs, from, { dynamic }) {
  const seen = new Set();
  const walk = (file) => {
    if (!file || seen.has(file) || !outputs[file]) return;
    seen.add(file);
    for (const i of outputs[file].imports) {
      if (i.kind === 'import-statement' || (dynamic && i.kind === 'dynamic-import')) walk(i.path);
    }
    const css = outputs[file].cssBundle;
    if (css) walk(css);
  };
  walk(from);
  return seen;
}

function checkBudget(meta, workerMeta, sizes) {
  const outputs = { ...meta.outputs, ...workerMeta.outputs };
  const kb = (n) => Math.round(n / 1024);
  const sum = (files) => kb([...files].reduce((n, f) => n + (outputs[f]?.bytes ?? 0), 0));
  const entryOf = (entry) =>
    Object.entries(meta.outputs).find(([, o]) => o.entryPoint === entry)?.[0];
  let failed = false;
  const report = (name, initial, total, limit) => {
    console.log(
      `Bundle ${name}: initial ${initial} kB (limit ${limit.initialKB}), total ${total} kB (limit ${limit.totalKB})`,
    );
    if (initial > limit.initialKB || total > limit.totalKB) failed = true;
  };

  const consoleEntry = entryOf('src/main.tsx');
  report(
    'console',
    sum(reach(outputs, consoleEntry, { dynamic: false })),
    sum(reach(outputs, consoleEntry, { dynamic: true })),
    BUDGET.console,
  );

  const wbEntry = entryOf('src/workbench/main.tsx');
  const wbTotal = reach(outputs, wbEntry, { dynamic: true });
  for (const f of Object.keys(workerMeta.outputs)) wbTotal.add(f);
  report(
    'workbench',
    sum(reach(outputs, wbEntry, { dynamic: false })),
    sum(wbTotal),
    BUDGET.workbench,
  );

  if (sizes) {
    for (const key of ['core', 'sqlite']) {
      const gz = kb(sizes[key].gzip);
      console.log(
        `WebAssembly ${key}: ${kb(sizes[key].raw)} kB raw, ${gz} kB gzip (limit ${BUDGET.wasmGzipKB[key]})`,
      );
      if (gz > BUDGET.wasmGzipKB[key]) failed = true;
    }
  }
  if (failed) {
    console.error('Bundle budget exceeded (see ADR-0020).');
    process.exit(1);
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, 'public'), dist, { recursive: true });
await copyExcalidrawAssets(dist);

const { assets, sizes } = await prepareCore();
const base = baseOptions({ dev });
const shared = {
  ...base,
  tsconfig: join(root, 'tsconfig.esbuild.json'),
  target: base.target,
  bundle: true,
  format: 'esm',
  // No source maps in production: dist/ is embedded in the binary (go:embed).
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  define: {
    ...base.define,
    'import.meta.env.MEMOBRAIN_E2E': JSON.stringify(e2e ? '1' : ''),
    __MEMOBRAIN_CORE__: JSON.stringify(assets),
    __MEMOBRAIN_VERSION__: JSON.stringify(version),
  },
};
delete shared.splitting;

const worker = await buildWorker(shared);

// The graph layout runs in a worker of its own at a fixed URL (the UI loads /assets/layout.worker.js).
await esbuild.build({
  ...shared,
  entryPoints: { 'layout.worker': graphWorkerEntry },
  outdir: join(dist, 'assets'),
  plugins: [],
  logLevel: 'warning',
});

const options = {
  ...shared,
  entryPoints: {
    main: join(root, 'src/main.tsx'),
    workbench: join(root, 'src/workbench/main.tsx'),
  },
  outdir: dist,
  entryNames: dev ? 'assets/[name]' : 'assets/[name]-[hash]',
  chunkNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/',
  splitting: true,
  metafile: true,
  logLevel: 'info',
  define: { ...shared.define, __MEMOBRAIN_WORKER__: JSON.stringify(worker.url) },
  plugins: dev ? [...base.plugins, html, reload] : [...base.plugins, html],
};

if (dev) {
  await writeFile(
    join(dist, 'dev-reload.js'),
    "new EventSource('/esbuild').addEventListener('change', () => location.reload());\n",
  );
  const app = await esbuild.context(options);
  await app.rebuild(); // dist/index.html must exist before the first request
  await app.watch();
  await serve(port);
  console.log(`Local: http://127.0.0.1:${port}/`);
} else {
  checkBudget((await esbuild.build(options)).metafile, worker.metafile, sizes);
}
