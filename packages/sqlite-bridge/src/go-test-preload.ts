/**
 * Node preload for running the Go core's tests as WebAssembly (`scripts/go-js-exec.sh`).
 * Databases are named in-memory sqlite-wasm databases, so a test that opens the same path twice
 * sees the same data, as it would with a file. A hidden "keeper" connection per path keeps the
 * data alive after the test closes its own connection: a file outlives its connections too.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createBridge, installBridge, type SqliteDatabase } from './index.ts';

const sqlite3 = await sqlite3InitModule();
const keepers = new Map<string, SqliteDatabase>();

const open = (path: string): SqliteDatabase =>
  new sqlite3.oo1.DB({
    filename: `file:/${encodeURIComponent(path)}?vfs=memdb`,
    flags: 'c',
  }) as unknown as SqliteDatabase;

/** A temp directory may be reached through a symlink (/var -> /private/var on macOS): one file, one name. */
function canonicalPath(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path; // the folder does not exist (yet)
  }
}

installBridge(
  createBridge({
    canonicalPath,
    openDatabase(path) {
      if (!keepers.has(path)) keepers.set(path, open(path));
      return open(path);
    },
    deleteDatabase(path) {
      keepers.get(path)?.close();
      keepers.delete(path);
    },
    databaseExists: (path) => keepers.has(path),
    columnTypes: (stmt) => {
      const s = stmt as unknown as { pointer: number; columnCount: number };
      return Array.from(
        { length: s.columnCount },
        (_, i) => sqlite3.capi.sqlite3_column_decltype(s.pointer, i) ?? '',
      );
    },
  }),
);
