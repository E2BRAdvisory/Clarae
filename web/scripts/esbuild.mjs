// Build and dev server of the Web UI (esbuild). Usage:
//   node scripts/esbuild.mjs build            production bundle in dist/ (embedded by the cloud binary)
//   node scripts/esbuild.mjs dev [--port N]   watch + serve dist/ with live reload, proxying /api to the cloud
//                                             (--no-watch builds once, for the e2e matrix)
// CLARAE_E2E=1 makes main.tsx install the OIDC test double (Playwright); it is compiled out otherwise.
//
// Two pages are built: the console (index.html) and the vault workbench (workbench.html, served for
// /vaults/:id/open). The workbench is a page of its own so that the desktop UI's global style sheet
// cannot reach the console (ADR-0029). It also needs the WebAssembly core, which `task wasm-core`
// produces in build/wasm/ (CLARAE_CORE_WASM overrides the path).
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
// The workbench's address (/vaults/:id/open), shared with the pages and checked against the cloud's.
import { isWorkbenchRoute } from '../src/shared/routes.ts';
import {
  baseOptions,
  copyExcalidrawAssets,
  copyTwemojiAssets,
  distDir,
  excalidrawFork,
  excalidrawForkPlugin,
  graphWorkerEntry,
  linkLazyStyles,
  liveCollab,
} from '@clarae/workbench/build';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// CLARAE_DIST builds elsewhere (the browser test of the production handler uses an E2E build of its own). An
// absolute path is taken as it is, a relative one starts at this package (never at the working directory).
const dist = distDir(root, 'dist');
const mode = process.argv[2] ?? 'build';
const dev = mode === 'dev';
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 5174;
const apiTarget = new URL(process.env['CLARAE_API'] ?? 'http://127.0.0.1:18081');
const e2e = process.env['CLARAE_E2E'] === '1';
// CLARAE_COLLAB=1 puts the (off) collaboration code in the build and lets the editor ask for it
// (ADR-0050); without it no Yjs is in any file and a profile cannot switch collaboration on.
const collab = process.env['CLARAE_COLLAB'] === '1';
// CLARAE_AI=1 lets the editor ask for the AI assistant (ADR-0050): the second gate, next to the `ai` flag
// of the Config Profile; a released build is made without it, so a profile cannot switch the assistant on.
const ai = process.env['CLARAE_AI'] === '1';
const version = process.env['CLARAE_VERSION'] ?? 'dev';

/** The pages of the app: each has an HTML template and the entry point it loads. */
const PAGES = [
  { entry: 'src/main.tsx', template: 'index.html', out: 'index.html' },
  {
    entry: 'src/workbench/main.tsx',
    template: 'workbench.html',
    out: 'workbench.html',
    importMap: true,
  },
];

/**
 * `<script type="importmap">` pinning every JS chunk of a build except its entry (which its own tag
 * pins), sorted so the page, and so the hash the cloud allows, only changes when a chunk does.
 */
async function chunkImportMap(result, entryFile) {
  const integrity = {};
  const chunks = Object.keys(result.metafile.outputs)
    .filter((f) => f.endsWith('.js') && f !== entryFile)
    .sort();
  for (const f of chunks) integrity[urlOf(f)] = sri384(await readFile(join(root, f)));
  if (!chunks.length) return '';
  return `    <script type="importmap">${JSON.stringify({ integrity })}</script>\n  `;
}

/**
 * Wires the workbench's out-of-graph scripts to the checked loaders of src/workbench/sri.ts (web build
 * only: the desktop build of the same sources keeps plain URLs):
 * - the graph layout worker: `new Worker('/assets/layout.worker.js', …)` in graph/layoutHost.ts becomes
 *   a VerifiedWorker of the hashed file this build wrote. The build fails if that call changes, so it
 *   cannot silently fall back to an unchecked worker;
 * - `import url from 'x.mjs?url'` of a script (the pdf.js worker) yields a blob: URL of the checked bytes
 *   instead of the file's URL (top-level await in the lazy chunk that imports it).
 */
const sriModule = join(root, 'src/workbench/sri.ts');
const LAYOUT_WORKER_CALL = /new Worker\(\s*'\/assets\/layout\.worker\.js'\s*,\s*(\{[^}]*\})\s*\)/g;
const verifiedLoaders = ({ layoutWorker }) => ({
  name: 'verified-loaders',
  setup(build) {
    build.onLoad({ filter: /[\\/]graph[\\/]layoutHost\.ts$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const found = source.match(LAYOUT_WORKER_CALL)?.length ?? 0;
      if (found !== 1)
        throw new Error(
          `${args.path}: expected one new Worker('/assets/layout.worker.js', …), found ${found}: update verifiedLoaders in web/scripts/esbuild.mjs`,
        );
      const call = `__verifiedWorker(${JSON.stringify(layoutWorker.url)}, ${JSON.stringify(layoutWorker.integrity)}, $1)`;
      return {
        contents:
          `import { verifiedWorker as __verifiedWorker } from ${JSON.stringify(sriModule)};\n` +
          source.replace(LAYOUT_WORKER_CALL, call),
        loader: 'ts',
        resolveDir: dirname(args.path),
      };
    });
    build.onResolve({ filter: /\.m?js\?url$/ }, async (args) => {
      const r = await build.resolve(args.path.replace(/\?url$/, ''), {
        resolveDir: args.resolveDir,
        kind: args.kind,
      });
      return r.errors.length ? r : { path: r.path, namespace: 'verified-url' };
    });
    build.onLoad({ filter: /.*/, namespace: 'verified-url' }, async (args) => ({
      resolveDir: dirname(sriModule),
      loader: 'js',
      contents: `import url from ${JSON.stringify(args.path + '?verified-file')};
import { verifiedScriptURL } from ${JSON.stringify(sriModule)};
export default await verifiedScriptURL(url, ${JSON.stringify(sri384(await readFile(args.path)))});
`,
    }));
    build.onResolve({ filter: /\?verified-file$/ }, (args) => ({
      path: args.path.replace(/\?verified-file$/, ''),
      namespace: 'verified-file',
    }));
    build.onLoad({ filter: /.*/, namespace: 'verified-file' }, async (args) => ({
      contents: await readFile(args.path),
      loader: 'file',
    }));
  },
});

const sha = (algo, bytes, enc) => createHash(algo).update(bytes).digest(enc);
/** The Subresource Integrity value of some bytes (sha384, what every pin of this build uses). */
const sri384 = (bytes) => `sha384-${sha('sha384', bytes, 'base64')}`;
/** The URL a file of dist/ is served at. */
const urlOf = (file) => '/' + relative(dist, join(root, file)).replaceAll('\\', '/');

/**
 * Writes the HTML pages with their hashed bundle and stylesheet. In production it also adds
 * Subresource Integrity (`integrity` + `crossorigin`, sha384) hashing the exact bytes written to
 * dist/: the cloud binary serves them behind a strict CSP with no inline script or style
 * (docs/web-ui.md).
 *
 * The workbench is code-split, and the browser fetches the chunks its entry imports (statically or
 * with import()) by URL, which a tag's integrity does not cover. So its page also gets an import map
 * whose `integrity` field pins every chunk of the build (Chromium 127+, Firefox 138+; browsers
 * without it ignore the field). It is the page's only inline script: the cloud allows it in the
 * workbench policy by its sha256, computed from the embedded page (web-embed, ImportMapHashes).
 */
const html = {
  name: 'index-html',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length || !result.metafile) return;
      // The lazy chunks link their own style sheets (the sheets' integrity in production): done before
      // the chunks are hashed for the import map below.
      await linkLazyStyles(result.metafile, {
        root,
        dist,
        entries: PAGES.map((p) => p.entry),
        integrity: dev ? () => '' : sri384,
      });
      const url = urlOf;
      const sri = async (p) => {
        if (dev) return '';
        return ` crossorigin integrity="${sri384(await readFile(join(root, p)))}"`;
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
        const importMap = page.importMap && !dev ? await chunkImportMap(result, file) : '';
        const script = new RegExp(
          `<script[^>]*src="/${page.entry.replaceAll('.', '\\.')}"[^>]*></script>`,
        );
        const text = (await readFile(join(root, page.template), 'utf8'))
          .replace('</head>', `${importMap}${css}</head>`)
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
  const corePath = process.env['CLARAE_CORE_WASM'] ?? join(root, '../build/wasm/clarae-core.wasm');
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
    ['core', 'clarae-core', corePath],
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

/**
 * A worker is a separate, self-contained bundle (no imports: the page starts it from a blob: URL of
 * the bytes it checked, see bridge.ts and sri.ts). Its URL and its SHA-384 are embedded in the
 * workbench bundle, which the page loads with SRI: `new Worker()` takes no integrity, so the page
 * fetches the script with it. Two workers: the core (Go WebAssembly, sync, vault keys) and the graph
 * layout.
 */
async function buildWorker(shared, name, entry) {
  const result = await esbuild.build({
    ...shared,
    entryPoints: { [name]: entry },
    outdir: join(dist, 'assets'),
    entryNames: dev ? '[name]' : '[name]-[hash]',
    splitting: false,
    metafile: true,
    plugins: [],
    logLevel: 'warning',
  });
  const out = Object.keys(result.metafile.outputs).find((o) => o.endsWith('.js'));
  const imports = result.metafile.outputs[out].imports.filter((i) => !i.external);
  if (imports.length)
    throw new Error(`the ${name} worker must be self-contained, it imports ${imports[0].path}`);
  return {
    url: urlOf(out),
    integrity: sri384(await readFile(join(root, out))),
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

function checkBudget(meta, workerMetas, sizes) {
  const workerOutputs = Object.assign({}, ...workerMetas.map((m) => m.outputs));
  const outputs = { ...meta.outputs, ...workerOutputs };
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
  for (const f of Object.keys(workerOutputs)) wbTotal.add(f);
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
await copyTwemojiAssets(dist);
// Excalidraw is a classic script added by a <script> tag at run time: the tag carries its integrity.
const excalidrawIntegrity = sri384(
  await readFile(join(dist, 'excalidraw-assets', 'excalidraw.js')),
);

const { assets, sizes } = await prepareCore();
const base = baseOptions({ dev });
const shared = {
  ...base,
  // The metafile paths (the entries, the sheets of linkLazyStyles) start at the package, wherever the script is run from.
  absWorkingDir: root,
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
    'import.meta.env.CLARAE_E2E': JSON.stringify(e2e ? '1' : ''),
    'import.meta.env.CLARAE_COLLAB': JSON.stringify(collab ? '1' : ''),
    'import.meta.env.CLARAE_AI': JSON.stringify(ai ? '1' : ''),
    __CLARAE_CORE__: JSON.stringify(assets),
    __CLARAE_VERSION__: JSON.stringify(version),
  },
};
delete shared.splitting;

const worker = await buildWorker(shared, 'core-worker', join(root, 'src/workbench/worker.ts'));
// The graph layout worker: hashed name, checked by the page like the core's (verifiedLoaders).
const layoutWorker = await buildWorker(shared, 'layout.worker', graphWorkerEntry);
const plugins = base.plugins.map((p) =>
  p === excalidrawFork ? excalidrawForkPlugin({ scriptIntegrity: excalidrawIntegrity }) : p,
);

// Two builds, so that the console is a single file covered by the SRI of its <script> tag: with code
// splitting the entry would import shared chunks, which the browser fetches without integrity. The
// console has no lazy part, so this costs nothing. The workbench keeps splitting (its lazy chunks,
// Excalidraw, mermaid, pdf.js…, would otherwise blow the initial budget): its chunks are pinned by
// the import map of its page (html plugin), its workers and Excalidraw's script by verifiedLoaders.
const common = {
  ...shared,
  outdir: dist,
  entryNames: dev ? 'assets/[name]' : 'assets/[name]-[hash]',
  chunkNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/',
  metafile: true,
  logLevel: 'info',
  plugins: [...plugins, liveCollab(collab), ...(dev ? [html, reload] : [html])],
};
const builds = [
  { ...common, entryPoints: { main: join(root, 'src/main.tsx') }, splitting: false },
  {
    ...common,
    entryPoints: { workbench: join(root, 'src/workbench/main.tsx') },
    splitting: true,
    plugins: [verifiedLoaders({ layoutWorker }), ...common.plugins],
    define: {
      ...shared.define,
      __CLARAE_WORKER__: JSON.stringify(worker.url),
      __CLARAE_WORKER_INTEGRITY__: JSON.stringify(worker.integrity),
    },
  },
];

if (dev) {
  await writeFile(
    join(dist, 'dev-reload.js'),
    "new EventSource('/esbuild').addEventListener('change', () => location.reload());\n",
  );
  for (const options of builds) {
    const app = await esbuild.context(options);
    await app.rebuild(); // dist/index.html must exist before the first request
    // --no-watch builds once: the e2e matrix keeps its pages from reloading while sources change.
    if (!process.argv.includes('--no-watch')) await app.watch();
  }
  await serve(port);
  console.log(`Local: http://127.0.0.1:${port}/`);
} else {
  const outputs = {};
  for (const options of builds)
    Object.assign(outputs, (await esbuild.build(options)).metafile.outputs);
  checkBudget({ outputs }, [worker.metafile, layoutWorker.metafile], sizes);
}
