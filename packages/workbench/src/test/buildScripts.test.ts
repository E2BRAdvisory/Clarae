// The pieces of the build that every app shares (build/esbuild.mjs): the loader of the style sheets of
// the lazy chunks, the copy of the Twemoji images and the collaboration chunk that only a build made for it has.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface Output {
  bytes: number;
  entryPoint?: string;
  cssBundle?: string;
  imports: { path: string; kind: string }[];
  inputs: Record<string, { bytesInOutput: number }>;
}
interface Build {
  linkLazyStyles: (
    metafile: { outputs: Record<string, Output> },
    o: { root: string; dist: string; entries: string[]; integrity?: (b: Uint8Array) => string },
  ) => Promise<{ linked: string[]; skipped: string[] }>;
  copyTwemojiAssets: (dist: string) => Promise<void>;
  distDir: (root: string, fallback: string, env?: string) => string;
}
// the package, wherever vitest is run from (the root of the repository or the package)
const pkg = join(import.meta.dirname, '../..');
const buildUrl = pathToFileURL(join(pkg, 'build/esbuild.mjs')).href;
const load = async (): Promise<Build> => (await import(/* @vite-ignore */ buildUrl)) as Build;

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clarae-build-'));
  await mkdir(join(root, 'dist/assets'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const css = (...files: string[]): Output['inputs'] =>
  Object.fromEntries(files.map((f) => [f, { bytesInOutput: 1 }]));
const out = (o: Partial<Output>): Output => ({ bytes: 1, imports: [], inputs: {}, ...o });

describe('linkLazyStyles', () => {
  async function run(pageCss: string[], lazyCss: string[]) {
    const { linkLazyStyles } = await load();
    for (const f of ['dist/assets/lazy.js', 'dist/assets/lazy.css'])
      await writeFile(join(root, f), 'x');
    const metafile = {
      outputs: {
        'dist/assets/main.js': out({
          entryPoint: 'src/main.tsx',
          cssBundle: 'dist/assets/main.css',
          imports: [{ path: 'dist/assets/lazy.js', kind: 'dynamic-import' }],
        }),
        'dist/assets/main.css': out({ inputs: css(...pageCss) }),
        'dist/assets/lazy.js': out({
          entryPoint: 'src/lazy.tsx',
          cssBundle: 'dist/assets/lazy.css',
        }),
        'dist/assets/lazy.css': out({ inputs: css(...lazyCss) }),
      },
    };
    const result = await linkLazyStyles(metafile, {
      root,
      dist: join(root, 'dist'),
      entries: ['src/main.tsx'],
    });
    return { result, chunk: await readFile(join(root, 'dist/assets/lazy.js'), 'utf8') };
  }

  it('links a sheet the page does not have, in front of the chunk', async () => {
    const { result, chunk } = await run(['a.css'], ['b.css']);
    expect(result).toEqual({ linked: ['dist/assets/lazy.css'], skipped: [] });
    expect(chunk).toContain('"url":"/assets/lazy.css"');
    expect(chunk.endsWith('x')).toBe(true);
  });

  it('links a sheet that has some files the page lacks, whole', async () => {
    const { result } = await run(['a.css'], ['a.css', 'b.css']);
    expect(result.linked).toEqual(['dist/assets/lazy.css']);
  });

  it('leaves out a sheet whose files the page has, and the chunk stays as it was', async () => {
    const { result, chunk } = await run(['a.css', 'b.css'], ['b.css']);
    expect(result).toEqual({ linked: [], skipped: ['dist/assets/lazy.css'] });
    expect(chunk).toBe('x');
  });
});

describe('distDir (CLARAE_DIST)', () => {
  it('uses the default folder of the package when the variable is not set, or empty', async () => {
    const { distDir } = await load();
    expect(distDir(root, 'dist', undefined)).toBe(join(root, 'dist'));
    expect(distDir(root, 'dist', '')).toBe(join(root, 'dist'));
  });

  it('starts a relative path at the package, whatever the working directory is', async () => {
    const { distDir } = await load();
    expect(distDir(root, 'dist', '../out/web')).toBe(resolve(root, '../out/web'));
    expect(distDir(`${root}/scripts/..`, 'dist', 'e2e/dist')).toBe(join(root, 'e2e/dist'));
  });

  it('takes an absolute path as it is (it is not joined to the package)', async () => {
    const { distDir } = await load();
    const elsewhere = join(tmpdir(), 'clarae-elsewhere', 'dist');
    expect(distDir(root, 'dist', elsewhere)).toBe(elsewhere);
  });

  it('refuses the package and its parents: the build empties the folder first', async () => {
    const { distDir } = await load();
    for (const bad of ['.', root, join(root, '..'), '/'])
      expect(() => distDir(root, 'dist', bad)).toThrow(/refusing/);
    expect(distDir(root, 'dist', `${root}-sibling`)).toBe(`${root}-sibling`);
  });
});

describe('lazyStyles from another working directory', { timeout: 30_000 }, () => {
  // esbuild's metafile paths start at its working directory: with `absWorkingDir: root` the loader is written
  // wherever the script is run from (it failed with ENOENT before). Run in a process of its own, like liveCollab.
  it('links the sheet of a chunk that no page reaches', async () => {
    const esbuild = pathToFileURL(createRequire(join(pkg, 'package.json')).resolve('esbuild')).href;
    const app = join(root, 'app');
    await mkdir(join(app, 'src'), { recursive: true });
    // a chunk that no page imports, so that its sheet is not in the page's (esbuild puts the sheets of what a
    // page reaches in the page's own)
    await writeFile(join(app, 'src/main.js'), "console.log('page');\n");
    await writeFile(join(app, 'src/lazy.js'), "import './lazy.css'; console.log('lazy');\n");
    await writeFile(join(app, 'src/lazy.css'), 'body { color: red; }\n');
    const dist = join(root, 'out-abs');
    const script = join(root, 'lazy.mjs');
    await writeFile(
      script,
      `import { build } from ${JSON.stringify(esbuild)};
import { lazyStyles } from ${JSON.stringify(buildUrl)};
const [app, dist] = process.argv.slice(2);
await build({
  absWorkingDir: app, entryPoints: { main: app + '/src/main.js', lazy: app + '/src/lazy.js' }, outdir: dist, bundle: true, splitting: true,
  format: 'esm', metafile: true, logLevel: 'silent', publicPath: '/', entryNames: 'assets/[name]',
  chunkNames: 'assets/[name]-[hash]', plugins: [lazyStyles({ root: app, dist, entries: ['src/main.js'] })],
});
`,
    );
    // the working directory is neither the package nor the app
    execFileSync(process.execPath, [script, app, dist], { cwd: tmpdir(), encoding: 'utf8' });
    const code = await readFile(join(dist, 'assets/lazy.js'), 'utf8');
    expect(code).toContain('rel=stylesheet');
    expect(code).toContain('"url":"/assets/lazy.css"');
    expect(code).toContain("console.log('lazy')".replace(/'/g, '"'));
  });
});

describe('copyTwemojiAssets', { timeout: 30_000 }, () => {
  it('copies the SVG images where the editor looks for them, with the attribution CC-BY asks for', async () => {
    const { copyTwemojiAssets } = await load();
    await copyTwemojiAssets(join(root, 'dist'));
    expect(existsSync(join(root, 'dist/emoji/svg/1f600.svg'))).toBe(true);
    expect(readFileSync(join(root, 'dist/emoji/svg/1f600.svg'), 'utf8')).toContain('<svg');
    const note = readFileSync(join(root, 'dist/emoji/ATTRIBUTION.txt'), 'utf8');
    expect(note).toContain('CC-BY 4.0');
    expect(note).toContain('Twitter, Inc.');
    expect(note).toContain('MIT License');
  });
});

describe('liveCollab', { timeout: 60_000 }, () => {
  // The collaboration chunk of the Live editor, as a bundle of its own (what the app's lazy import is).
  // esbuild refuses to run inside jsdom (the global Uint8Array differs), so it runs in a process of its own.
  async function bundle(enabled: boolean): Promise<string> {
    const esbuild = pathToFileURL(createRequire(join(pkg, 'package.json')).resolve('esbuild')).href;
    const script = join(root, 'bundle.mjs');
    await writeFile(
      script,
      `import { build } from ${JSON.stringify(esbuild)};
import { liveCollab } from ${JSON.stringify(buildUrl)};
const chunk = ${JSON.stringify(join(pkg, 'src/editor/live/chunks/collab.ts'))};
const result = await build({
  stdin: { contents: 'export * from ' + JSON.stringify(chunk) + ';', resolveDir: ${JSON.stringify(pkg)} },
  bundle: true, write: false, format: 'esm', platform: 'browser', minify: true, logLevel: 'silent',
  tsconfig: ${JSON.stringify(join(pkg, 'tsconfig.app.json'))},
  plugins: [liveCollab(process.argv[2] === 'on')],
});
process.stdout.write(result.outputFiles[0].text);
`,
    );
    return execFileSync(process.execPath, [script, enabled ? 'on' : 'off'], {
      cwd: pkg,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  it('leaves Yjs and the plugin out of a build that is not made for collaboration', async () => {
    const code = await bundle(false);
    expect(code.length).toBeLessThan(1000);
    expect(code).not.toContain('MILKDOWN_COLLAB_KEYMAP'); // plugin-collab
    expect(code).toContain('collaboration is not in this build');
  });

  it('puts them in a build made for it', async () => {
    const code = await bundle(true);
    expect(code).toContain('MILKDOWN_COLLAB_KEYMAP');
    expect(code).not.toContain('collaboration is not in this build');
  });
});
