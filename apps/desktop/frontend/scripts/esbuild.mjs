// Build and dev server of the desktop frontend (esbuild). Usage:
//   node scripts/esbuild.mjs build            production bundle in dist/
//   node scripts/esbuild.mjs dev [--port N]   watch + serve dist/ with live reload (Wails dev, Playwright)
// MEMOBRAIN_E2E=1 makes main.tsx install the in-memory Wails mock (Playwright).
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url)) + '/..';
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);
const mode = process.argv[2] ?? 'build';
const dev = mode === 'dev';
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
  sourcemap: dev ? 'inline' : 'linked',
  minify: !dev,
  conditions: [dev ? 'development' : 'production'],
  metafile: true,
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
  plugins: [urlImports, html],
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
  const { hosts, port: p } = await app.serve({ servedir: dist, port, host: 'localhost' });
  console.log(`Local: http://${hosts[0] ?? 'localhost'}:${p}/`);
} else {
  await esbuild.build(options);
  await esbuild.build(workerOptions);
}
