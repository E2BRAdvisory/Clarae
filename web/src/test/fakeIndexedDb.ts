// A small in-memory IndexedDB for unit tests (jsdom has none): the part device.ts uses (databases with
// versions and upgrades, object stores with a key path, get/put/delete/getAll, transactions, and
// deleteDatabase), with the events and ordering of the real one where the code relies on them.
// Operations apply when requested and their results arrive in later tasks, so a transaction stays
// open while its callbacks issue more requests, as in a browser.

export interface StoreData {
  keyPath: string | string[];
  rows: Map<string, unknown>;
}
export interface DbData {
  version: number;
  stores: Map<string, StoreData>;
}

const keyOf = (k: unknown): string => JSON.stringify(k);

function rowKey(store: StoreData, row: unknown): unknown {
  const r = row as Record<string, unknown>;
  return Array.isArray(store.keyPath) ? store.keyPath.map((p) => r[p]) : r[store.keyPath];
}

class FakeRequest<T = unknown> {
  result: T | undefined;
  error: Error | null = null;
  readyState: 'pending' | 'done' = 'pending';
  transaction: FakeTransaction | null = null;
  onsuccess: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onblocked: ((ev: unknown) => void) | null = null;
  onupgradeneeded: ((ev: { oldVersion: number }) => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  aborted = false;
  private pending = 0;
  private finished = false;
  constructor(
    private readonly db: DbData,
    private readonly names: string[],
    readonly mode: string,
  ) {
    setTimeout(() => this.settle(), 0);
  }

  /** Schedules the delivery of a request's result; the transaction waits for it. */
  deliver<T>(req: FakeRequest<T>, result: T): FakeRequest<T> {
    this.pending++;
    setTimeout(() => {
      if (!this.aborted) {
        req.result = result;
        req.readyState = 'done';
        req.onsuccess?.({ target: req });
      }
      this.pending--;
      this.settle();
    }, 0);
    return req;
  }

  private settle(): void {
    if (this.finished || this.pending > 0) return;
    // Callbacks run in tasks of their own: look again once they had their turn.
    setTimeout(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      if (this.aborted) this.onabort?.();
      else this.oncomplete?.();
    }, 0);
  }

  abort(): void {
    this.aborted = true;
    this.error = Object.assign(new Error('AbortError'), { name: 'AbortError' });
    this.settle();
  }

  objectStore(name: string): FakeStore {
    const s = this.db.stores.get(name);
    const allowed = this.mode === 'versionchange' || this.names.includes(name);
    if (!s || !allowed)
      throw Object.assign(new Error(`no store ${name}`), { name: 'NotFoundError' });
    return new FakeStore(this, s);
  }
}

class FakeStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: StoreData,
  ) {}
  private req<T>(result: T): FakeRequest<T> {
    return this.tx.deliver(new FakeRequest<T>(), result);
  }
  get(key: unknown): FakeRequest {
    return this.req(this.data.rows.get(keyOf(key)));
  }
  getAll(): FakeRequest {
    return this.req([...this.data.rows.values()]);
  }
  put(row: unknown): FakeRequest {
    const key = rowKey(this.data, row);
    this.data.rows.set(keyOf(key), structuredClone(row));
    return this.req(key);
  }
  delete(key: unknown): FakeRequest {
    this.data.rows.delete(keyOf(key));
    return this.req(undefined);
  }
}

class FakeDatabase {
  constructor(
    private readonly data: DbData,
    private readonly upgrade: FakeTransaction | null,
  ) {}
  get objectStoreNames(): { contains(n: string): boolean } {
    return { contains: (n) => this.data.stores.has(n) };
  }
  createObjectStore(name: string, o: { keyPath: string | string[] }): FakeStore {
    const s: StoreData = { keyPath: o.keyPath, rows: new Map() };
    this.data.stores.set(name, s);
    return new FakeStore(this.upgrade as FakeTransaction, s);
  }
  deleteObjectStore(name: string): void {
    this.data.stores.delete(name);
  }
  transaction(names: string[], mode: IDBTransactionMode): FakeTransaction {
    return new FakeTransaction(this.data, names, mode);
  }
  close(): void {
    /* nothing is held */
  }
}

/** The handle a test gets with the fake: the databases to look into, and how to undo it. */
export interface FakeIndexedDb {
  databases: Map<string, DbData>;
  /** Makes `indexedDB.databases()` absent, as in browsers that lack it. */
  withoutDatabasesList(): void;
  /** Creates a database as an earlier version left it: stores with their key paths and rows. */
  seed(
    name: string,
    version: number,
    stores: Record<string, { keyPath: string | string[]; rows: unknown[] }>,
  ): void;
  /** The rows of a store of a database, or null when the database or the store is not there. */
  rows(name: string, store: string): unknown[] | null;
  restore: () => void;
}

/** Installs a fresh fake `indexedDB`. */
export function installFakeIndexedDb(): FakeIndexedDb {
  const databases = new Map<string, DbData>();
  const fake: Record<string, unknown> = {
    databases(): Promise<{ name: string; version: number }[]> {
      return Promise.resolve([...databases].map(([name, d]) => ({ name, version: d.version })));
    },
    open(name: string, version?: number): FakeRequest {
      const req = new FakeRequest<FakeDatabase>();
      setTimeout(() => {
        const existing = databases.get(name);
        const want = version ?? existing?.version ?? 1;
        if (existing && want < existing.version) {
          req.error = Object.assign(new Error('VersionError'), { name: 'VersionError' });
          req.onerror?.({ target: req });
          return;
        }
        const data: DbData = existing ?? { version: 0, stores: new Map() };
        const oldVersion = data.version;
        if (existing && oldVersion === want) {
          req.result = new FakeDatabase(data, null);
          req.onsuccess?.({ target: req });
          return;
        }
        // An upgrade works on a copy that is kept only when its transaction completes.
        const staged: DbData = {
          version: want,
          stores: new Map([...data.stores].map(([n, s]) => [n, { ...s, rows: new Map(s.rows) }])),
        };
        const tx = new FakeTransaction(staged, [], 'versionchange');
        req.transaction = tx;
        req.result = new FakeDatabase(staged, tx);
        tx.oncomplete = () => {
          databases.set(name, staged);
          req.onsuccess?.({ target: req });
        };
        tx.onabort = () => {
          req.error = tx.error;
          req.onerror?.({ target: req });
        };
        req.onupgradeneeded?.({ oldVersion });
      }, 0);
      return req;
    },
    deleteDatabase(name: string): FakeRequest {
      const req = new FakeRequest();
      setTimeout(() => {
        databases.delete(name);
        req.onsuccess?.({ target: req });
      }, 0);
      return req;
    },
  };
  const g = globalThis as unknown as { indexedDB?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'indexedDB');
  Object.defineProperty(g, 'indexedDB', { configurable: true, writable: true, value: fake });
  return {
    databases,
    withoutDatabasesList: () => {
      delete fake['databases'];
    },
    seed: (name, version, stores) => {
      databases.set(name, {
        version,
        stores: new Map(
          Object.entries(stores).map(([n, s]) => [
            n,
            {
              keyPath: s.keyPath,
              rows: new Map(
                s.rows.map((r) => [keyOf(rowKey({ keyPath: s.keyPath, rows: new Map() }, r)), r]),
              ),
            },
          ]),
        ),
      });
    },
    rows: (name, store) => {
      const s = databases.get(name)?.stores.get(store);
      return s ? [...s.rows.values()] : null;
    },
    restore: () => {
      if (had) Object.defineProperty(g, 'indexedDB', had);
      else delete g.indexedDB;
    },
  };
}
