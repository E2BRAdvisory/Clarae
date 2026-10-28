// Build and dev server of the Web UI (esbuild). Usage:
//   node scripts/esbuild.mjs build            production bundle in dist/ (embedded by the cloud binary)
//   node scripts/esbuild.mjs dev [--port N]   watch + serve dist/ with live reload, proxying /api to the cloud
// MEMOBRAIN_E2E=1 makes main.tsx install the OIDC test double (Playwright); it is compiled out otherwise.
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { dirname, extname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const dist = join(root, 'dist');
const mode = process.argv[2] ?? 'build';
const dev = mode === 'dev';
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 5174;
const apiTarget = new URL(process.env['MEMOBRAIN_API'] ?? 'http://127.0.0.1:18081');
const e2e = process.env['MEMOBRAIN_E2E'] === '1';

/**
 * Writes dist/index.html with the hashed bundle and stylesheet. In production it also adds
 * Subresource Integrity (`integrity` + `crossorigin`, sha384) hashing the exact bytes written to
 * dist/: the cloud binary serves it behind a strict CSP with no inline script or style
 * (docs/web-ui.md).
 */
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
      const sri = async (p) => {
        if (dev) return '';
        const digest = createHash('sha384')
          .update(await readFile(join(root, p)))
          .digest('base64');
        return ` crossorigin integrity="sha384-${digest}"`;
      };
      const css = meta.cssBundle
        ? `    <link rel="stylesheet" href="${url(meta.cssBundle)}"${await sri(meta.cssBundle)} />\n  `
        : '';
      const reload = dev ? '\n    <script src="/dev-reload.js"></script>' : '';
      const page = (await readFile(join(root, 'index.html'), 'utf8'))
        .replace('</head>', `${css}</head>`)
        .replace(
          /<script[^>]*src="\/src\/main\.tsx"[^>]*><\/script>/,
          `<script type="module" src="${url(file)}"${await sri(file)}></script>${reload}`,
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
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Static server for dist/ with the SPA fallback to index.html and a proxy of /api to the cloud. */
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
      file = join(dist, 'index.html');
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

const options = {
  entryPoints: { main: join(root, 'src/main.tsx') },
  outdir: dist,
  entryNames: dev ? 'assets/[name]' : 'assets/[name]-[hash]',
  chunkNames: 'assets/[name]-[hash]',
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
  legalComments: 'none',
  logLevel: 'info',
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    'import.meta.env.MEMOBRAIN_E2E': JSON.stringify(e2e ? '1' : ''),
  },
  plugins: dev ? [html, reload] : [html],
};

/** Bundle budget (ADR-0020): what the app loads at start and everything the build emits. */
const BUDGET = { initialKB: 700, totalKB: 1000 };

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
await cp(join(root, 'public'), dist, { recursive: true });

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
  checkBudget((await esbuild.build(options)).metafile);
}
