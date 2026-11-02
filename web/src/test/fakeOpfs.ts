// An in-memory Origin Private File System for unit tests (jsdom has none): the directory and file
// handle methods storage.ts uses, with the errors the browsers throw. `busy` paths refuse removal as
// a folder held by another tab's synchronous handles does.

type Node = FakeDir | FakeFile;

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

class FakeFile {
  readonly kind = 'file';
  constructor(
    readonly name: string,
    public text = '',
  ) {}
  getFile(): Promise<{ text(): Promise<string> }> {
    return Promise.resolve({ text: () => Promise.resolve(this.text) });
  }
  createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> {
    let buf = '';
    return Promise.resolve({
      write: (d: string) => {
        buf += d;
        return Promise.resolve();
      },
      close: () => {
        this.text = buf;
        return Promise.resolve();
      },
    });
  }
}

export class FakeDir {
  readonly kind = 'directory';
  readonly children = new Map<string, Node>();
  constructor(
    readonly name: string,
    private readonly busy: Set<FakeDir> = new Set(),
  ) {}

  getDirectoryHandle(name: string, o: { create?: boolean } = {}): Promise<FakeDir> {
    const c = this.children.get(name);
    if (c instanceof FakeDir) return Promise.resolve(c);
    if (c) return Promise.reject(domError('TypeMismatchError'));
    if (!o.create) return Promise.reject(domError('NotFoundError'));
    const d = new FakeDir(name, this.busy);
    this.children.set(name, d);
    return Promise.resolve(d);
  }

  getFileHandle(name: string, o: { create?: boolean } = {}): Promise<FakeFile> {
    const c = this.children.get(name);
    if (c instanceof FakeFile) return Promise.resolve(c);
    if (c) return Promise.reject(domError('TypeMismatchError'));
    if (!o.create) return Promise.reject(domError('NotFoundError'));
    const f = new FakeFile(name);
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
export function installFakeOpfs(): { root: FakeDir; restore: () => void } {
  const root = new FakeDir('');
  const nav = navigator as unknown as { storage?: unknown };
  const had = Object.getOwnPropertyDescriptor(nav, 'storage');
  Object.defineProperty(nav, 'storage', {
    configurable: true,
    value: { getDirectory: () => Promise.resolve(root) },
  });
  return {
    root,
    restore: () => {
      if (had) Object.defineProperty(nav, 'storage', had);
      else delete nav.storage;
    },
  };
}
