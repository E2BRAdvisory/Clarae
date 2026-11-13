/**
 * Synchronous SQLite bridge for the Go core compiled to WebAssembly (ADR-0030).
 *
 * The Go side (`apps/desktop/internal/sqlitejs`) is a `database/sql` driver that calls the methods
 * of `globalThis.__claraeSQLite` through `syscall/js`. Both run in the same Web Worker, so every
 * call is synchronous. The bridge knows nothing about OPFS: the caller supplies `openDatabase`
 * (the `opfs-sahpool` VFS in the browser, in-memory databases in tests).
 *
 * Wire format (kept in step with `internal/sqlitejs/driver_js.go`):
 *  - parameters: number, string, null, Uint8Array (BLOB) or BigInt (integers beyond 2^53);
 *  - cells: number, string, null, Uint8Array, or `{ i64: "<decimal>" }` for integers beyond 2^53.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** The part of the sqlite-wasm `oo1.Database` this bridge uses. */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  changes(): number | bigint;
  close(): void;
  selectValue(sql: string): unknown;
}

/** The part of the sqlite-wasm `oo1.Statement` this bridge uses. */
export interface SqliteStatement {
  bind(values: unknown[]): unknown;
  step(): boolean;
  get(target: unknown[]): unknown[];
  getColumnNames(): string[];
  finalize(): void;
}

export interface BridgeOptions {
  /** Maps a path to the name the database is stored under (symlinks resolved, say); default: as is. */
  canonicalPath?(path: string): string;
  /** Opens (creating if needed) the database stored under `path`. */
  openDatabase(path: string): SqliteDatabase;
  /** Deletes the database stored under `path` (used by "rebuild index"); optional. */
  deleteDatabase?(path: string): void;
  /** Whether a database is stored under `path`; by default, whether this bridge ever opened it. */
  databaseExists?(path: string): boolean;
  /**
   * The declared type of each result column ("TIMESTAMP", "INTEGER", ...; "" for expressions), from
   * `sqlite3_column_decltype`. The Go driver turns TEXT in DATE/DATETIME/TIMESTAMP columns into
   * time.Time, as modernc.org/sqlite does. Without it every column is reported as untyped.
   */
  columnTypes?(stmt: SqliteStatement): string[];
}

export interface SqliteBridge {
  open(path: string): number;
  close(db: number): void;
  exec(db: number, sql: string, params: unknown[]): { changes: number; lastInsertId: WireInt };
  query(
    db: number,
    sql: string,
    params: unknown[],
  ): { cursor: number; columns: string[]; types: string[] };
  fetch(cursor: number, max: number): { rows: WireCell[][]; done: boolean };
  closeCursor(cursor: number): void;
  deleteDatabase(path: string): void;
  exists(path: string): boolean;
}

export type WireInt = number | { i64: string };
export type WireCell = number | string | null | Uint8Array | { i64: string };

/** Integers outside the safe range cross the boundary as `{ i64 }`: a JS number would round them. */
function toWire(v: unknown): WireCell {
  if (typeof v === 'bigint') {
    return v >= MIN_SAFE && v <= MAX_SAFE ? Number(v) : { i64: v.toString() };
  }
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as WireCell;
}

function wireInt(v: unknown): WireInt {
  const w = toWire(v);
  return typeof w === 'number' || (typeof w === 'object' && w !== null && 'i64' in w) ? w : 0;
}

/** Builds the bridge. Handles are small integers, valid until closed. */
export function createBridge(opts: BridgeOptions): SqliteBridge {
  const dbs = new Map<number, SqliteDatabase>();
  const opened = new Set<string>();
  const canon = (path: string): string => (opts.canonicalPath ? opts.canonicalPath(path) : path);
  const cursors = new Map<number, { stmt: SqliteStatement; columns: string[]; db: number }>();
  let next = 1;

  const db = (id: number): SqliteDatabase => {
    const d = dbs.get(id);
    if (!d) throw new Error(`sqlite bridge: unknown database handle ${id}`);
    return d;
  };

  return {
    open(rawPath) {
      const path = canon(rawPath);
      const id = next++;
      dbs.set(id, opts.openDatabase(path));
      opened.add(path);
      return id;
    },
    close(id) {
      const d = dbs.get(id);
      if (!d) return;
      for (const [cid, c] of [...cursors]) {
        if (c.db === id) closeCursorInternal(cid); // a connection owns its open statements
      }
      dbs.delete(id);
      d.close();
    },
    exec(id, sql, params) {
      const d = db(id);
      if (params.length === 0) {
        d.exec(sql); // may hold several statements (migrations)
      } else {
        const stmt = d.prepare(sql);
        try {
          stmt.bind(params);
          while (stmt.step()) {
            /* discard rows */
          }
        } finally {
          stmt.finalize();
        }
      }
      return {
        changes: Number(d.changes()),
        lastInsertId: wireInt(d.selectValue('SELECT last_insert_rowid()')),
      };
    },
    query(id, sql, params) {
      const stmt = db(id).prepare(sql);
      try {
        if (params.length > 0) stmt.bind(params);
      } catch (e) {
        stmt.finalize();
        throw e;
      }
      const cid = next++;
      const columns = stmt.getColumnNames();
      const types = opts.columnTypes ? opts.columnTypes(stmt) : columns.map(() => '');
      cursors.set(cid, { stmt, columns, db: id });
      return { cursor: cid, columns, types };
    },
    fetch(cid, max) {
      const c = cursors.get(cid);
      if (!c) throw new Error(`sqlite bridge: unknown cursor ${cid}`);
      const rows: WireCell[][] = [];
      let done = false;
      while (rows.length < max) {
        if (!c.stmt.step()) {
          done = true;
          break;
        }
        rows.push(c.stmt.get([]).map(toWire));
      }
      if (done) closeCursorInternal(cid);
      return { rows, done };
    },
    closeCursor(cid) {
      closeCursorInternal(cid);
    },
    deleteDatabase(rawPath) {
      const path = canon(rawPath);
      opts.deleteDatabase?.(path);
      opened.delete(path);
    },
    exists(rawPath) {
      const path = canon(rawPath);
      return opts.databaseExists ? opts.databaseExists(path) : opened.has(path);
    },
  };

  function closeCursorInternal(cid: number): void {
    const c = cursors.get(cid);
    if (!c) return;
    cursors.delete(cid);
    c.stmt.finalize();
  }
}

/** Publishes the bridge where the Go driver looks for it. */
export function installBridge(bridge: SqliteBridge, target: object = globalThis): void {
  (target as Record<string, unknown>)['__claraeSQLite'] = bridge;
}
