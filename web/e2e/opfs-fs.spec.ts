import * as esbuild from 'esbuild';
import { expect, test, type Page } from '@playwright/test';

// The fs shim needs synchronous access handles, which exist only in dedicated workers: the module is
// bundled, started in a worker from a Blob URL, and exercised there with what Go's os package calls.
const bundle = esbuild.buildSync({
  entryPoints: ['src/workbench/opfs-fs.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'OpfsFs',
  write: false,
  target: 'es2022',
}).outputFiles[0]!.text;

/** Runs `body` (the text of an async function body) in a worker with the shim installed. */
async function inWorker(page: Page, body: string): Promise<unknown> {
  const script = `${bundle}
const call = (name, ...args) => new Promise((resolve, reject) => {
  globalThis.fs[name](...args, (err, res) => (err ? reject(err) : resolve(res)));
});
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? String(e); } };
const text = (u) => new TextDecoder().decode(u);
const bytes = (s) => new TextEncoder().encode(s);
const O = globalThis.fs ? null : null;
(async () => {
  try {
    const opfs = await OpfsFs.installOpfsFs(globalThis, { rootName: 'probe' });
    const C = globalThis.fs.constants;
    const result = await (async () => { ${body} })();
    postMessage({ ok: true, result });
  } catch (e) {
    postMessage({ ok: false, error: String(e && e.stack || e) });
  }
})();`;
  const out = await page.evaluate(async (src) => {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    return new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      worker.onmessage = (e) =>
        resolve(e.data as { ok: boolean; result?: unknown; error?: string });
    });
  }, script);
  if (!out.ok) throw new Error(out.error);
  return out.result;
}

test.describe('OPFS fs shim (what Go os calls)', () => {
  test.beforeEach(async ({ page }) => {
    // A static file of the app's origin (a secure context with OPFS): no script of the dev server that could reload it.
    await page.goto('/favicon.svg');
  });

  test('creates, writes, reads and stats a file', async ({ page }) => {
    const r = await inWorker(
      page,
      `
      await call('mkdir', '/v', 0o755);
      const fd = await call('open', '/v/a.md', C.O_WRONLY | C.O_CREAT | C.O_TRUNC, 0o644);
      const n = await call('write', fd, bytes('hello world'), 0, 11, null);
      await call('fsync', fd);
      await call('close', fd);
      const rfd = await call('open', '/v/a.md', C.O_RDONLY, 0);
      const buf = new Uint8Array(32);
      const got = await call('read', rfd, buf, 0, 32, null);
      await call('close', rfd);
      const st = await call('stat', '/v/a.md');
      return { n, got, content: text(buf.subarray(0, got)), size: st.size, dir: st.isDirectory(), mode: st.mode & 0o170000, mtime: st.mtimeMs > 0 };
    `,
    );
    expect(r).toEqual({
      n: 11,
      got: 11,
      content: 'hello world',
      size: 11,
      dir: false,
      mode: 0o100000,
      mtime: true,
    });
  });

  test('reports the errno Go maps (ENOENT, EEXIST, ENOTDIR, EISDIR, ENOTEMPTY)', async ({
    page,
  }) => {
    const r = await inWorker(
      page,
      `
      await call('mkdir', '/d', 0o755);
      const fd = await call('open', '/d/f', C.O_WRONLY | C.O_CREAT, 0o644);
      await call('close', fd);
      return {
        missing: await code(() => call('stat', '/nope')),
        openMissing: await code(() => call('open', '/nope/x', C.O_RDONLY, 0)),
        mkdirExists: await code(() => call('mkdir', '/d', 0o755)),
        mkdirNoParent: await code(() => call('mkdir', '/x/y', 0o755)),
        exclusive: await code(() => call('open', '/d/f', C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o644)),
        throughFile: await code(() => call('stat', '/d/f/x')),
        writeDir: await code(() => call('open', '/d', C.O_WRONLY, 0)),
        rmdirFull: await code(() => call('rmdir', '/d')),
        unlinkDir: await code(() => call('unlink', '/d')),
        symlink: await code(() => call('symlink', '/d/f', '/l')),
        badFd: await code(() => call('close', 999)),
      };
    `,
    );
    expect(r).toEqual({
      missing: 'ENOENT',
      openMissing: 'ENOENT',
      mkdirExists: 'EEXIST',
      mkdirNoParent: 'ENOENT',
      exclusive: 'EEXIST',
      throughFile: 'ENOTDIR',
      writeDir: 'EISDIR',
      rmdirFull: 'ENOTEMPTY',
      unlinkDir: 'EISDIR',
      symlink: 'ENOSYS',
      badFd: 'EBADF',
    });
  });

  test('lists folders and treats a folder descriptor as readable by readdir', async ({ page }) => {
    const r = await inWorker(
      page,
      `
      await call('mkdir', '/v', 0o755);
      await call('mkdir', '/v/sub', 0o755);
      for (const n of ['b.md', 'a.md']) { const fd = await call('open', '/v/' + n, C.O_WRONLY | C.O_CREAT, 0o644); await call('close', fd); }
      const names = (await call('readdir', '/v')).sort();
      const dfd = await call('open', '/v', C.O_RDONLY, 0);
      const st = await call('fstat', dfd);
      await call('close', dfd);
      return { names, dirStat: st.isDirectory() };
    `,
    );
    expect(r).toEqual({ names: ['a.md', 'b.md', 'sub'], dirStat: true });
  });

  test('rename replaces an existing file atomically (what writeAtomic relies on)', async ({
    page,
  }) => {
    const r = await inWorker(
      page,
      `
      const put = async (p, s) => { const fd = await call('open', p, C.O_WRONLY | C.O_CREAT | C.O_TRUNC, 0o644); await call('write', fd, bytes(s), 0, s.length, null); await call('close', fd); };
      const get = async (p) => { const fd = await call('open', p, C.O_RDONLY, 0); const b = new Uint8Array(64); const n = await call('read', fd, b, 0, 64, null); await call('close', fd); return text(b.subarray(0, n)); };
      await call('mkdir', '/v', 0o755);
      await put('/v/note.md', 'OLD');
      await put('/v/.memobrain-tmp-1', 'NEW CONTENT');
      await call('rename', '/v/.memobrain-tmp-1', '/v/note.md');
      return { content: await get('/v/note.md'), tmpGone: await code(() => call('stat', '/v/.memobrain-tmp-1')), names: (await call('readdir', '/v')) };
    `,
    );
    expect(r).toEqual({ content: 'NEW CONTENT', tmpGone: 'ENOENT', names: ['note.md'] });
  });

  test('what the shim writes and renames is what the rest of the browser sees (and keeps)', async ({
    page,
  }) => {
    await inWorker(
      page,
      `
      const put = async (p, s) => { const fd = await call('open', p, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o644); await call('write', fd, bytes(s), 0, s.length, null); await call('fsync', fd); await call('close', fd); };
      await call('mkdir', '/v', 0o755);
      await put('/v/.memobrain-tmp-9', 'persisted text');
      await call('rename', '/v/.memobrain-tmp-9', '/v/Kept.md');
    `,
    );
    // A listing and a read from the page itself (a different context from the worker that wrote it).
    const seen = await page.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('probe');
      const v = await root.getDirectoryHandle('v');
      const names: string[] = [];
      for await (const [n] of (
        v as unknown as { entries(): AsyncIterable<[string, unknown]> }
      ).entries())
        names.push(n);
      const text = await (await (await v.getFileHandle('Kept.md')).getFile()).text();
      return { names, text };
    });
    expect(seen).toEqual({ names: ['Kept.md'], text: 'persisted text' });
  });

  test('renames a folder with its contents and refuses a non-empty destination', async ({
    page,
  }) => {
    const r = await inWorker(
      page,
      `
      const put = async (p, s) => { const fd = await call('open', p, C.O_WRONLY | C.O_CREAT, 0o644); await call('write', fd, bytes(s), 0, s.length, null); await call('close', fd); };
      await call('mkdir', '/a', 0o755);
      await call('mkdir', '/a/deep', 0o755);
      await put('/a/deep/f.md', 'x');
      await call('mkdir', '/full', 0o755);
      await put('/full/keep', 'k');
      const refused = await code(() => call('rename', '/a', '/full'));
      await call('rename', '/a', '/b');
      return { refused, old: await code(() => call('stat', '/a')), moved: (await call('stat', '/b/deep/f.md')).size };
    `,
    );
    expect(r).toEqual({ refused: 'ENOTEMPTY', old: 'ENOENT', moved: 1 });
  });

  test('descriptors on the same file share one handle; append and positional I/O work', async ({
    page,
  }) => {
    const r = await inWorker(
      page,
      `
      const w = await call('open', '/f', C.O_RDWR | C.O_CREAT, 0o644);
      const r2 = await call('open', '/f', C.O_RDONLY, 0);
      await call('write', w, bytes('abcdef'), 0, 6, null);
      const b = new Uint8Array(3);
      const at2 = await call('read', r2, b, 0, 3, 2); // positional: "cde"
      const a = await call('open', '/f', C.O_WRONLY | C.O_APPEND, 0);
      await call('write', a, bytes('XY'), 0, 2, null);
      await call('ftruncate', w, 7);
      const st = await call('fstat', w);
      const all = new Uint8Array(16);
      const n = await call('read', r2, all, 0, 16, 0);
      for (const f of [w, r2, a]) await call('close', f);
      return { at2, part: text(b), size: st.size, all: text(all.subarray(0, n)) };
    `,
    );
    expect(r).toEqual({ at2: 3, part: 'cde', size: 7, all: 'abcdefX' });
  });

  test('opening the same file from several places at once shares one handle (no EBUSY)', async ({
    page,
  }) => {
    const r = await inWorker(
      page,
      `
      const fd = await call('open', '/shared', C.O_WRONLY | C.O_CREAT, 0o644);
      await call('write', fd, bytes('shared bytes'), 0, 12, null);
      await call('close', fd);
      // What Go does when the UI reads a note while the indexer and the history read it too.
      const fds = await Promise.all(Array.from({ length: 12 }, () => call('open', '/shared', C.O_RDONLY, 0)));
      const texts = await Promise.all(fds.map(async (f) => { const b = new Uint8Array(32); const n = await call('read', f, b, 0, 32, 0); return text(b.subarray(0, n)); }));
      for (const f of fds) await call('close', f);
      // And the file can be opened for writing again once every reader is gone.
      const again = await call('open', '/shared', C.O_WRONLY, 0);
      await call('close', again);
      return { distinct: [...new Set(texts)], count: texts.length };
    `,
    );
    expect(r).toEqual({ distinct: ['shared bytes'], count: 12 });
  });

  test('truncate, unlink, rmdir and removeTree', async ({ page }) => {
    const r = await inWorker(
      page,
      `
      const put = async (p, s) => { const fd = await call('open', p, C.O_WRONLY | C.O_CREAT, 0o644); await call('write', fd, bytes(s), 0, s.length, null); await call('close', fd); };
      await call('mkdir', '/t', 0o755);
      await put('/t/a', '0123456789');
      await call('truncate', '/t/a', 4);
      const size = (await call('stat', '/t/a')).size;
      await call('unlink', '/t/a');
      await call('rmdir', '/t');
      await call('mkdir', '/w', 0o755);
      await call('mkdir', '/w/x', 0o755);
      await put('/w/x/y', 'z');
      await opfs.removeTree('/w');
      return { size, gone: await opfs.exists('/t'), removed: await opfs.exists('/w'), list: await opfs.list('/') };
    `,
    );
    expect(r).toEqual({ size: 4, gone: false, removed: false, list: [] });
  });

  test('handles a multi-megabyte file and keeps bytes intact', async ({ page }) => {
    const r = await inWorker(
      page,
      `
      const size = 3 * 1024 * 1024 + 17;
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 255;
      const fd = await call('open', '/big', C.O_WRONLY | C.O_CREAT, 0o644);
      let off = 0;
      while (off < size) { off += await call('write', fd, data, off, Math.min(65536, size - off), null); }
      await call('close', fd);
      const back = await opfs.readFile('/big');
      let ok = back.length === size;
      for (let i = 0; ok && i < size; i += 4099) if (back[i] !== data[i]) ok = false;
      return { ok, length: back.length };
    `,
    );
    expect(r).toEqual({ ok: true, length: 3 * 1024 * 1024 + 17 });
  });

  test('provides what Go asks of the process and path', async ({ page }) => {
    const r = await inWorker(
      page,
      `
      return { cwd: process.cwd(), uid: process.getuid(), resolved: path.resolve('a/../b', 'c'), abs: path.resolve('/x', '/y/z'), umask: process.umask() };
    `,
    );
    expect(r).toEqual({ cwd: '/', uid: 1000, resolved: '/b/c', abs: '/y/z', umask: 18 });
  });
});
