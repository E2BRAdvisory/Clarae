// An in-memory Origin Private File System for unit tests (jsdom has none): the directory and file
// handle methods storage.ts uses, with the errors the browsers throw. `busy` paths refuse removal as
// a folder held by another tab's synchronous handles does.

type Node = FakeDir | FakeFile;

/** What the fake browser can do; tests change it between steps. */
export interface FakeOpfsOptions {
  /** Whether `FileSystemHandle.move` works on folders (it does not in every browser). */
  move: boolean;
  /** Number of file writes still allowed before one fails with QuotaExceededError; null: no limit. */
  writesLeft: number | null;
}

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

type Blobish = string | { text(): Promise<string> };

class FakeFile {
  readonly kind = 'file';
  constructor(
    readonly name: string,
    public text = '',
    private readonly opts: FakeOpfsOptions = { move: false, writesLeft: null },
  ) {}
  getFile(): Promise<{ text(): Promise<string>; size: number }> {
    return Promise.resolve({
      text: () => Promise.resolve(this.text),
      size: new TextEncoder().encode(this.text).length,
    });
  }
  createWritable(): Promise<{
    write(d: Blobish): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    let buf = '';
    return Promise.resolve({
      write: async (d: Blobish) => {
        buf += typeof d === 'string' ? d : await d.text();
      },
      close: () => {
        if (this.opts.writesLeft !== null) {
          if (this.opts.writesLeft <= 0) return Promise.reject(domError('QuotaExceededError'));
          this.opts.writesLeft--;
        }
        this.text = buf;
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
    });
  }
}

export class FakeDir {
  readonly kind = 'directory';
  readonly children = new Map<string, Node>();
  private parent: FakeDir | null = null;
  constructor(
    public name: string,
    private readonly busy: Set<FakeDir> = new Set(),
    readonly opts: FakeOpfsOptions = { move: false, writesLeft: null },
  ) {}

  getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<FakeDir> {
    const c = this.children.get(name);
    if (c instanceof FakeDir) return Promise.resolve(c);
    if (c) return Promise.reject(domError('TypeMismatchError'));
    if (!o.create) return Promise.reject(domError('NotFoundError'));
    const d = new FakeDir(name, this.busy, this.opts);
    d.parent = this;
    this.children.set(name, d);
    return Promise.resolve(d);
  }

  getFileHandle(name: string, o: { create?: boolean } = {}): Promise<FakeFile> {
    const c = this.children.get(name);
    if (c instanceof FakeFile) return Promise.resolve(c);
    if (c) return Promise.reject(domError('TypeMismatchError'));
    if (!o.create) return Promise.reject(domError('NotFoundError'));
    const f = new FakeFile(name, '', this.opts);
    this.children.set(name, f);
    return Promise.resolve(f);
  }

  removeEntry(name: string, o: { recursive?: boolean } = {}): Promise<void> {
    const c = this.children.get(name);
    if (!c) return Promise.reject(domError('NotFoundError'));
    if (c instanceof FakeDir) {
      if (c.children.size > 0 && !o.recursive)
        return Promise.reject(domError('InvalidModificationError'));
      if (c.holdsBusy()) return Promise.reject(domError('NoModificationAllowedError'));
    }
    this.children.delete(name);
    return Promise.resolve();
  }

  /** `FileSystemHandle.move` for a folder: one atomic step, where the fake browser has it. */
  move(dest: FakeDir, name: string): Promise<void> {
    if (!this.opts.move || !this.parent) return Promise.reject(domError('NotSupportedError'));
    if (this.holdsBusy()) return Promise.reject(domError('NoModificationAllowedError'));
    if (dest.children.has(name)) return Promise.reject(domError('InvalidModificationError'));
    this.parent.children.delete(this.name);
    this.name = name;
    this.parent = dest;
    dest.children.set(name, this);
    return Promise.resolve();
  }

  async *entries(): AsyncIterable<[string, Node]> {
    for (const e of [...this.children.entries()]) yield await Promise.resolve(e);
  }

  /** Marks this folder as held open by another tab. */
  hold(): void {
    this.busy.add(this);
  }

  private holdsBusy(): boolean {
    if (this.busy.has(this)) return true;
    return [...this.children.values()].some((c) => c instanceof FakeDir && c.holdsBusy());
  }

  // ---- test helpers ----

  /** Creates the folders of a path ("a/b/c"). */
  async mkdir(path: string): Promise<FakeDir> {
    const [head, ...rest] = path.split('/').filter(Boolean);
    if (!head) return this;
    return (await this.getDirectoryHandle(head, { create: true })).mkdir(rest.join('/'));
  }

  /** Writes a file at a path, creating its folders. */
  async write(path: string, text: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    const dir = await this.mkdir(parts.slice(0, -1).join('/'));
    (await dir.getFileHandle(parts[parts.length - 1] as string, { create: true })).text = text;
  }

  /** The text of the file at a path, or null. */
  read(path: string): string | null {
    const [head, ...rest] = path.split('/').filter(Boolean);
    const c = head === undefined ? undefined : this.children.get(head);
    if (c instanceof FakeFile) return rest.length === 0 ? c.text : null;
    return c instanceof FakeDir && rest.length > 0 ? c.read(rest.join('/')) : null;
  }

  /** The names at the root of this folder, sorted. */
  names(): string[] {
    return [...this.children.keys()].sort();
  }

  /** Whether a path exists. */
  has(path: string): boolean {
    const [head, ...rest] = path.split('/').filter(Boolean);
    if (!head) return true;
    const c = this.children.get(head);
    if (!c) return false;
    if (rest.length === 0) return true;
    return c instanceof FakeDir && c.has(rest.join('/'));
  }
}

/** Installs a fresh fake OPFS as navigator.storage; returns its root and the function that removes it. */
export function installFakeOpfs(): {
  root: FakeDir;
  options: FakeOpfsOptions;
  restore: () => void;
} {
  const options: FakeOpfsOptions = { move: false, writesLeft: null };
  const root = new FakeDir('', new Set(), options);
  const nav = navigator as unknown as { storage?: unknown };
  const had = Object.getOwnPropertyDescriptor(nav, 'storage');
  Object.defineProperty(nav, 'storage', {
    configurable: true,
    value: { getDirectory: () => Promise.resolve(root) },
  });
  return {
    root,
    options,
    restore: () => {
      if (had) Object.defineProperty(nav, 'storage', had);
      else delete nav.storage;
    },
  };
}
