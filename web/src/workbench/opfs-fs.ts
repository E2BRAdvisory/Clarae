/**
 * A POSIX-flavoured `fs` for the Go core running as WebAssembly in a Web Worker (ADR-0030).
 *
 * On GOOS=js Go's `os` package calls `globalThis.fs` (the object wasm_exec.js fills with Node's `fs`
 * in Node). This module provides one backed by the Origin Private File System, so the desktop's Go
 * code (vault.FS, history, sync, importer) keeps using plain `os` calls unchanged. Files are read and
 * written through synchronous access handles, which exist only in dedicated workers.
 *
 * Differences from a real file system that the core can live with:
 *  - a file has one synchronous handle at a time; descriptors opened on the same path share it;
 *  - permissions, owners, links and symlinks do not exist (chmod/chown succeed, links are ENOSYS);
 *  - mtime has the resolution of the browser's `lastModified` (milliseconds).
 */

// ---- constants and errors ---------------------------------------------------------------------------

const O = {
  RDONLY: 0,
  WRONLY: 1,
  RDWR: 2,
  CREAT: 0x40,
  EXCL: 0x80,
  TRUNC: 0x200,
  APPEND: 0x400,
  DIRECTORY: 0x10000,
  SYNC: 0x101000,
} as const;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** An error Go can map to an errno through its `code`. */
class FsError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.code = code;
  }
}

type Callback<T = undefined> = (err: FsError | null, result?: T) => void;

// ---- paths ------------------------------------------------------------------------------------------

/** Splits an absolute or relative path into segments, resolving `.` and `..` against `/`. */
export function segments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out;
}

const keyOf = (segs: string[]): string => '/' + segs.join('/');

function inode(key: string): number {
  // FNV-1a, kept below 2^53 so it survives the trip through a JavaScript number.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h + 1;
}

// ---- OPFS handle types the DOM lib does not cover yet -------------------------------------------------

interface SyncHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
type FileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncHandle>;
  move?(dir: FileSystemDirectoryHandle, name: string): Promise<void>;
};
type DirHandle = FileSystemDirectoryHandle & {
  move?(dir: FileSystemDirectoryHandle, name: string): Promise<void>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** Translates a DOMException of the File System API into the errno Go expects. */
function toFsError(e: unknown, fallback = 'EIO'): FsError {
  if (e instanceof FsError) return e;
  const name = (e as { name?: string })?.name;
  switch (name) {
    case 'NotFoundError':
      return new FsError('ENOENT');
    case 'TypeMismatchError':
      return new FsError('ENOTDIR');
    case 'InvalidModificationError':
      return new FsError('ENOTEMPTY');
    case 'NoModificationAllowedError':
      return new FsError('EBUSY', 'the file is open in another handle or tab');
    case 'NotAllowedError':
    case 'SecurityError':
      return new FsError('EACCES');
    case 'QuotaExceededError':
      return new FsError('ENOSPC');
    default:
      return new FsError(fallback, String((e as Error)?.message ?? e));
  }
}

// ---- descriptors ------------------------------------------------------------------------------------

/** One synchronous handle shared by every descriptor open on the same file. */
interface OpenFile {
  key: string;
  file: FileHandle;
  sah: SyncHandle;
  refs: number;
  /** Set when this session wrote the file: `lastModified` is not updated until the handle closes. */
  mtimeMs: number;
}

type Fd =
  | {
      kind: 'file';
      open: OpenFile;
      pos: number;
      readable: boolean;
      writable: boolean;
      append: boolean;
    }
  | { kind: 'dir'; key: string }
  | { kind: 'std'; n: 0 | 1 | 2 };

interface Stats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function makeStats(key: string, dir: boolean, size: number, mtimeMs: number): Stats {
  return {
    dev: 1,
    ino: inode(key),
    mode: dir ? S_IFDIR | 0o755 : S_IFREG | 0o644,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    atimeMs: mtimeMs,
    mtimeMs,
    ctimeMs: mtimeMs,
    isDirectory: () => dir,
    isFile: () => !dir,
    isSymbolicLink: () => false,
  };
}

// ---- the file system --------------------------------------------------------------------------------

export interface OpfsFs {
  /** Whole-file helpers for the host (downloads, wiping a vault); they bypass the descriptor table. */
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  /** Removes a file or a folder with everything in it. Missing paths are fine. */
  removeTree(path: string): Promise<void>;
  /** Names inside a folder ([] when it does not exist). */
  list(path: string): Promise<string[]>;
}

export interface InstallOptions {
  /** Name of the OPFS folder that holds the whole file system (default "fs"). */
  rootName?: string;
  /** Where Go's stdout/stderr (descriptors 1 and 2) go (default: the console). */
  onStdio?: (fd: 1 | 2, text: string) => void;
  /** Called with every file system call and its outcome (diagnostics only). */
  trace?: (line: string) => void;
}

/**
 * Installs `fs`, `path` and `process` on `target` (the worker's global scope), before wasm_exec.js is
 * loaded: wasm_exec.js only fills in what is missing.
 */
export async function installOpfsFs(
  target: Record<string, unknown> = globalThis,
  options: InstallOptions = {},
): Promise<OpfsFs> {
  const base = await navigator.storage.getDirectory();
  const root = (await base.getDirectoryHandle(options.rootName ?? 'fs', {
    create: true,
  })) as DirHandle;
  const decoder = new TextDecoder();
  const onStdio =
    options.onStdio ??
    ((fd: 1 | 2, text: string) => (fd === 1 ? console.log(text) : console.error(text)));

  const dirs = new Map<string, DirHandle>([['/', root]]);
  const opened = new Map<string, OpenFile>();
  const fds = new Map<number, Fd>([
    [0, { kind: 'std', n: 0 }],
    [1, { kind: 'std', n: 1 }],
    [2, { kind: 'std', n: 2 }],
  ]);
  let nextFd = 3;
  const mtimes = new Map<string, number>();
  let stdoutLine = '';

  // -- lookup --

  async function dirAt(segs: string[]): Promise<DirHandle> {
    const key = keyOf(segs);
    const hit = dirs.get(key);
    if (hit) return hit;
    const parent = await dirAt(segs.slice(0, -1));
    try {
      const h = (await parent.getDirectoryHandle(segs[segs.length - 1] as string)) as DirHandle;
      dirs.set(key, h);
      return h;
    } catch (e) {
      // A file where a folder was expected is ENOTDIR, not "missing".
      const name = (e as { name?: string }).name;
      if (name === 'TypeMismatchError') throw new FsError('ENOTDIR');
      throw toFsError(e);
    }
  }

  type Entry = { dir: true; handle: DirHandle } | { dir: false; handle: FileHandle };

  async function lookup(segs: string[]): Promise<Entry | null> {
    if (segs.length === 0) return { dir: true, handle: root };
    const parent = await dirAt(segs.slice(0, -1));
    const name = segs[segs.length - 1] as string;
    try {
      return { dir: false, handle: (await parent.getFileHandle(name)) as FileHandle };
    } catch (e) {
      const n = (e as { name?: string }).name;
      if (n !== 'TypeMismatchError' && n !== 'NotFoundError') throw toFsError(e);
      if (n === 'NotFoundError') return null;
    }
    try {
      return { dir: true, handle: await parent.getDirectoryHandle(name) };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFoundError') return null;
      throw toFsError(e);
    }
  }

  async function isEmpty(dir: DirHandle): Promise<boolean> {
    for await (const entry of dir.entries()) {
      void entry;
      return false;
    }
    return true;
  }

  /** Copies a folder with everything in it; used where FileSystemHandle.move does not cover folders. */
  async function copyTree(from: DirHandle, to: DirHandle): Promise<void> {
    for await (const [name, h] of from.entries()) {
      if (h.kind === 'directory') {
        await copyTree(h as DirHandle, await to.getDirectoryHandle(name, { create: true }));
        continue;
      }
      const data = new Uint8Array(await (await (h as FileHandle).getFile()).arrayBuffer());
      const out = (await to.getFileHandle(name, { create: true })) as FileHandle;
      const sah = await out.createSyncAccessHandle();
      try {
        sah.truncate(0);
        sah.write(data, { at: 0 });
        sah.flush();
      } finally {
        sah.close();
      }
    }
  }

  function forgetDirs(prefix: string): void {
    for (const k of [...dirs.keys()])
      if (k !== '/' && (k === prefix || k.startsWith(prefix + '/'))) dirs.delete(k);
  }

  /** Opens in flight, so that two goroutines opening the same file at once share one handle instead of racing for it. */
  const acquiring = new Map<string, Promise<OpenFile>>();

  async function acquire(key: string, file: FileHandle): Promise<OpenFile> {
    const have = opened.get(key);
    if (have) {
      have.refs++;
      return have;
    }
    const waiting = acquiring.get(key);
    if (waiting) {
      const o = await waiting;
      o.refs++;
      return o;
    }
    const open = (async (): Promise<OpenFile> => {
      let sah: SyncHandle;
      try {
        sah = await file.createSyncAccessHandle();
      } catch (e) {
        throw toFsError(e);
      }
      const o: OpenFile = { key, file, sah, refs: 1, mtimeMs: 0 };
      opened.set(key, o);
      return o;
    })();
    acquiring.set(key, open);
    try {
      return await open;
    } finally {
      acquiring.delete(key);
    }
  }

  function release(o: OpenFile): void {
    if (--o.refs > 0) return;
    opened.delete(o.key);
    try {
      o.sah.flush();
      o.sah.close();
    } catch {
      /* already closed */
    }
  }

  async function fileMtime(key: string, file: FileHandle): Promise<number> {
    return mtimes.get(key) ?? (await file.getFile()).lastModified;
  }

  async function statEntry(key: string, e: Entry): Promise<Stats> {
    if (e.dir) return makeStats(key, true, 4096, mtimes.get(key) ?? 0);
    const o = opened.get(key);
    const size = o ? o.sah.getSize() : (await e.handle.getFile()).size;
    return makeStats(key, false, size, await fileMtime(key, e.handle));
  }

  // -- operations (each reports through a Node-style callback) --

  function op<T>(cb: Callback<T>, work: () => Promise<T | undefined>): void {
    work().then(
      (r) => cb(null, r),
      (e) => cb(toFsError(e)),
    );
  }

  const fd = (n: number): Fd => {
    const f = fds.get(n);
    if (!f) throw new FsError('EBADF');
    return f;
  };

  const fs = {
    constants: {
      O_RDONLY: O.RDONLY,
      O_WRONLY: O.WRONLY,
      O_RDWR: O.RDWR,
      O_CREAT: O.CREAT,
      O_EXCL: O.EXCL,
      O_TRUNC: O.TRUNC,
      O_APPEND: O.APPEND,
      O_DIRECTORY: O.DIRECTORY,
      O_SYNC: O.SYNC,
    },

    open(path: string, flags: number, _mode: number, cb: Callback<number>) {
      op(cb, async () => {
        const segs = segments(path);
        const key = keyOf(segs);
        const writable = (flags & (O.WRONLY | O.RDWR)) !== 0;
        let entry = await lookup(segs);
        if (entry && flags & O.CREAT && flags & O.EXCL) throw new FsError('EEXIST');
        if (entry?.dir) {
          if (writable) throw new FsError('EISDIR');
          const n = nextFd++;
          fds.set(n, { kind: 'dir', key });
          return n;
        }
        if (!entry) {
          if (!(flags & O.CREAT)) throw new FsError('ENOENT');
          if (segs.length === 0) throw new FsError('EISDIR');
          const parent = await dirAt(segs.slice(0, -1));
          const handle = (await parent.getFileHandle(segs[segs.length - 1] as string, {
            create: true,
          })) as FileHandle;
          entry = { dir: false, handle };
          mtimes.set(key, Date.now());
        }
        if (flags & O.DIRECTORY) throw new FsError('ENOTDIR');
        const open = await acquire(key, entry.handle);
        if (writable && flags & O.TRUNC) {
          open.sah.truncate(0);
          open.mtimeMs = Date.now();
          mtimes.set(key, open.mtimeMs);
        }
        const n = nextFd++;
        fds.set(n, {
          kind: 'file',
          open,
          pos: 0,
          readable: (flags & O.WRONLY) === 0,
          writable,
          append: (flags & O.APPEND) !== 0,
        });
        return n;
      });
    },

    close(n: number, cb: Callback) {
      op(cb, () => {
        const f = fd(n);
        fds.delete(n);
        if (f.kind === 'file') release(f.open);
        return Promise.resolve(undefined);
      });
    },

    read(
      n: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
      cb: Callback<number>,
    ) {
      op(cb, () => {
        const f = fd(n);
        if (f.kind === 'std') return Promise.resolve(0); // stdin is empty
        if (f.kind === 'dir') throw new FsError('EISDIR');
        if (!f.readable) throw new FsError('EBADF');
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        const at = position ?? f.pos;
        const read = f.open.sah.read(view, { at });
        if (position === null) f.pos += read;
        return Promise.resolve(read);
      });
    },

    write(
      n: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
      cb: Callback<number>,
    ) {
      op(cb, () => {
        const f = fd(n);
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        if (f.kind === 'std') {
          // Go's runtime and log output: line-buffered into the console.
          stdoutLine += decoder.decode(view, { stream: true });
          let i: number;
          while ((i = stdoutLine.indexOf('\n')) >= 0) {
            onStdio(f.n as 1 | 2, stdoutLine.slice(0, i));
            stdoutLine = stdoutLine.slice(i + 1);
          }
          return Promise.resolve(length);
        }
        if (f.kind === 'dir') throw new FsError('EISDIR');
        if (!f.writable) throw new FsError('EBADF');
        const at = position ?? (f.append ? f.open.sah.getSize() : f.pos);
        const wrote = f.open.sah.write(view, { at });
        if (position === null) f.pos = at + wrote;
        f.open.mtimeMs = Date.now();
        mtimes.set(f.open.key, f.open.mtimeMs);
        return Promise.resolve(wrote);
      });
    },

    fsync(n: number, cb: Callback) {
      op(cb, () => {
        const f = fd(n);
        if (f.kind === 'file') f.open.sah.flush();
        return Promise.resolve(undefined);
      });
    },

    fstat(n: number, cb: Callback<Stats>) {
      op(cb, async () => {
        const f = fd(n);
        if (f.kind === 'std') return makeStats(`/dev/std${f.n}`, false, 0, Date.now());
        if (f.kind === 'dir') return makeStats(f.key, true, 4096, mtimes.get(f.key) ?? 0);
        return makeStats(
          f.open.key,
          false,
          f.open.sah.getSize(),
          await fileMtime(f.open.key, f.open.file),
        );
      });
    },

    stat(path: string, cb: Callback<Stats>) {
      op(cb, async () => {
        const segs = segments(path);
        const e = await lookup(segs);
        if (!e) throw new FsError('ENOENT');
        return statEntry(keyOf(segs), e);
      });
    },

    readdir(path: string, cb: Callback<string[]>) {
      op(cb, async () => {
        const e = await lookup(segments(path));
        if (!e) throw new FsError('ENOENT');
        if (!e.dir) throw new FsError('ENOTDIR');
        const names: string[] = [];
        for await (const [name] of e.handle.entries()) names.push(name);
        return names;
      });
    },

    mkdir(path: string, _mode: number, cb: Callback) {
      op(cb, async () => {
        const segs = segments(path);
        if (segs.length === 0 || (await lookup(segs))) throw new FsError('EEXIST');
        const parent = await dirAt(segs.slice(0, -1));
        const h = (await parent.getDirectoryHandle(segs[segs.length - 1] as string, {
          create: true,
        })) as DirHandle;
        dirs.set(keyOf(segs), h);
        mtimes.set(keyOf(segs), Date.now());
        return undefined;
      });
    },

    rmdir(path: string, cb: Callback) {
      op(cb, async () => {
        const segs = segments(path);
        const e = await lookup(segs);
        if (!e) throw new FsError('ENOENT');
        if (!e.dir) throw new FsError('ENOTDIR');
        if (segs.length === 0) throw new FsError('EBUSY');
        if (!(await isEmpty(e.handle))) throw new FsError('ENOTEMPTY');
        const parent = await dirAt(segs.slice(0, -1));
        await parent.removeEntry(segs[segs.length - 1] as string);
        forgetDirs(keyOf(segs));
        return undefined;
      });
    },

    unlink(path: string, cb: Callback) {
      op(cb, async () => {
        const segs = segments(path);
        const e = await lookup(segs);
        if (!e) throw new FsError('ENOENT');
        if (e.dir) throw new FsError('EISDIR');
        const key = keyOf(segs);
        const parent = await dirAt(segs.slice(0, -1));
        await parent.removeEntry(segs[segs.length - 1] as string);
        mtimes.delete(key);
        return undefined;
      });
    },

    rename(from: string, to: string, cb: Callback) {
      op(cb, async () => {
        const f = segments(from);
        const t = segments(to);
        const src = await lookup(f);
        if (!src) throw new FsError('ENOENT');
        if (f.length === 0) throw new FsError('EBUSY');
        const dst = await lookup(t);
        if (dst?.dir && !src.dir) throw new FsError('EISDIR');
        if (dst && !dst.dir && src.dir) throw new FsError('ENOTDIR');
        if (dst?.dir && !(await isEmpty(dst.handle))) throw new FsError('ENOTEMPTY');
        if (keyOf(f) === keyOf(t)) return undefined;
        const toParent = await dirAt(t.slice(0, -1));
        const toName = t[t.length - 1] as string;
        const handle = src.handle as unknown as {
          move?(dir: FileSystemDirectoryHandle, name: string): Promise<void>;
        };
        if (src.dir && !handle.move) {
          // Folders cannot be moved in every browser: copy the tree, then remove the original.
          const target = (await toParent.getDirectoryHandle(toName, { create: true })) as DirHandle;
          await copyTree(src.handle, target);
          const fromParent = await dirAt(f.slice(0, -1));
          await fromParent.removeEntry(f[f.length - 1] as string, { recursive: true });
        } else if (!handle.move) {
          throw new FsError('ENOSYS', 'FileSystemHandle.move is not available in this browser');
        } else {
          await handle.move(toParent, toName);
        }
        const fk = keyOf(f);
        const tk = keyOf(t);
        forgetDirs(fk);
        forgetDirs(tk);
        const m = mtimes.get(fk);
        mtimes.delete(fk);
        if (m !== undefined) mtimes.set(tk, m);
        return undefined;
      });
    },

    ftruncate(n: number, length: number, cb: Callback) {
      op(cb, () => {
        const f = fd(n);
        if (f.kind !== 'file' || !f.writable) throw new FsError('EINVAL');
        f.open.sah.truncate(length);
        f.open.mtimeMs = Date.now();
        mtimes.set(f.open.key, f.open.mtimeMs);
        return Promise.resolve(undefined);
      });
    },

    truncate(path: string, length: number, cb: Callback) {
      op(cb, async () => {
        const segs = segments(path);
        const e = await lookup(segs);
        if (!e) throw new FsError('ENOENT');
        if (e.dir) throw new FsError('EISDIR');
        const o = await acquire(keyOf(segs), e.handle);
        try {
          o.sah.truncate(length);
          mtimes.set(o.key, Date.now());
        } finally {
          release(o);
        }
        return undefined;
      });
    },

    utimes(path: string, _atime: number, mtime: number, cb: Callback) {
      op(cb, () => {
        mtimes.set(keyOf(segments(path)), mtime * 1000);
        return Promise.resolve(undefined);
      });
    },

    // Permissions and ownership do not exist here: succeed without doing anything.
    chmod: (_p: string, _m: number, cb: Callback) => cb(null),
    fchmod: (_f: number, _m: number, cb: Callback) => cb(null),
    chown: (_p: string, _u: number, _g: number, cb: Callback) => cb(null),
    fchown: (_f: number, _u: number, _g: number, cb: Callback) => cb(null),
    lchown: (_p: string, _u: number, _g: number, cb: Callback) => cb(null),

    // There are no links.
    lstat(path: string, cb: Callback<Stats>) {
      fs.stat(path, cb);
    },
    readlink: (_p: string, cb: Callback) => cb(new FsError('EINVAL')),
    symlink: (_a: string, _b: string, cb: Callback) => cb(new FsError('ENOSYS')),
    link: (_a: string, _b: string, cb: Callback) => cb(new FsError('ENOSYS')),
  };

  if (options.trace) {
    const trace = options.trace;
    for (const name of Object.keys(fs) as (keyof typeof fs)[]) {
      // The methods do not use `this`, so calling them detached is safe.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const fn = fs[name];
      if (typeof fn !== 'function') continue;
      (fs as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const cb = args[args.length - 1] as (e: FsError | null, r?: unknown) => void;
        const shown = args
          .slice(0, -1)
          .map((a) =>
            typeof a === 'object' && a !== null ? `<${a.constructor.name}>` : String(a),
          );
        (fn as (...a: unknown[]) => void)(
          ...args.slice(0, -1),
          (e: FsError | null, r?: unknown) => {
            trace(
              `${name}(${shown.join(', ')}) -> ${e ? e.code : typeof r === 'object' && r !== null ? '<object>' : String(r)}`,
            );
            cb(e, r);
          },
        );
      };
    }
  }

  target['fs'] = fs;
  target['path'] = {
    resolve: (...parts: string[]) => {
      let acc: string[] = [];
      for (const p of parts)
        acc = p.startsWith('/') ? segments(p) : segments(acc.join('/') + '/' + p);
      return keyOf(acc);
    },
  };
  // Go asks the process for ids and the working directory; everything is root-relative here.
  target['process'] = {
    getuid: () => 1000,
    getgid: () => 1000,
    geteuid: () => 1000,
    getegid: () => 1000,
    getgroups: () => [1000],
    pid: 1,
    ppid: 0,
    umask: () => 0o22,
    cwd: () => '/',
    chdir: () => undefined,
  };

  return {
    async readFile(path) {
      const segs = segments(path);
      const e = await lookup(segs);
      if (!e) throw new FsError('ENOENT');
      if (e.dir) throw new FsError('EISDIR');
      const o = opened.get(keyOf(segs));
      if (o) {
        const out = new Uint8Array(o.sah.getSize());
        o.sah.read(out, { at: 0 });
        return out;
      }
      return new Uint8Array(await (await e.handle.getFile()).arrayBuffer());
    },
    async exists(path) {
      return (await lookup(segments(path))) !== null;
    },
    async removeTree(path) {
      const segs = segments(path);
      if (segs.length === 0) throw new FsError('EBUSY', 'cannot remove the root');
      const parent = await lookup(segs.slice(0, -1));
      if (!parent?.dir) return;
      // Close what is open under the path first: a handle with an open sync access handle cannot be removed.
      const prefix = keyOf(segs);
      for (const [k, o] of [...opened]) {
        if (k === prefix || k.startsWith(prefix + '/')) {
          o.refs = 1;
          release(o);
          for (const [n, f] of [...fds]) if (f.kind === 'file' && f.open === o) fds.delete(n);
        }
      }
      try {
        await parent.handle.removeEntry(segs[segs.length - 1] as string, { recursive: true });
      } catch (e) {
        if ((e as { name?: string }).name !== 'NotFoundError') throw toFsError(e);
      }
      forgetDirs(prefix);
      for (const k of [...mtimes.keys()])
        if (k === prefix || k.startsWith(prefix + '/')) mtimes.delete(k);
    },
    async list(path) {
      const e = await lookup(segments(path));
      if (!e?.dir) return [];
      const names: string[] = [];
      for await (const [name] of e.handle.entries()) names.push(name);
      return names;
    },
  };
}

/** Exposed for tests: what the shim reports as errors. */
export { FsError };
