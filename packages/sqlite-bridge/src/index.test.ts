import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBridge, type SqliteBridge, type SqliteDatabase } from './index.ts';

let bridge: SqliteBridge;
let bridgeDb: (path: string) => SqliteDatabase;

beforeAll(async () => {
  const sqlite3 = await sqlite3InitModule();
  bridgeDb = (path) =>
    new sqlite3.oo1.DB({
      filename: `file:/${path.replace(/\W/g, '_')}?vfs=memdb`,
      flags: 'c',
    }) as unknown as SqliteDatabase;
  bridge = createBridge({ openDatabase: bridgeDb });
});

describe('sqlite bridge', () => {
  it('runs DDL, inserts with parameters and reads rows back in batches', () => {
    const db = bridge.open('t1');
    bridge.exec(db, 'CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, data BLOB, score REAL)', []);
    for (let i = 1; i <= 5; i++) {
      const r = bridge.exec(db, 'INSERT INTO t(name, data, score) VALUES(?, ?, ?)', [
        `n${i}`,
        new Uint8Array([i, 0, 255]),
        i / 2,
      ]);
      expect(r.changes).toBe(1);
      expect(r.lastInsertId).toBe(i);
    }
    const { cursor, columns } = bridge.query(
      db,
      'SELECT id, name, data, score FROM t ORDER BY id',
      [],
    );
    expect(columns).toEqual(['id', 'name', 'data', 'score']);
    const first = bridge.fetch(cursor, 3);
    expect(first.done).toBe(false);
    expect(first.rows).toHaveLength(3);
    expect(first.rows[0]).toEqual([1, 'n1', new Uint8Array([1, 0, 255]), 0.5]);
    const rest = bridge.fetch(cursor, 3);
    expect(rest.done).toBe(true);
    expect(rest.rows).toHaveLength(2);
    bridge.close(db);
  });

  it('keeps 64-bit integers exact (nanosecond mtimes exceed 2^53)', () => {
    const db = bridge.open('t2');
    bridge.exec(db, 'CREATE TABLE t(v INTEGER)', []);
    const big = 1761750000123456789n;
    bridge.exec(db, 'INSERT INTO t VALUES(?)', [big]);
    const { cursor } = bridge.query(db, 'SELECT v FROM t', []);
    expect(bridge.fetch(cursor, 10).rows).toEqual([[{ i64: big.toString() }]]);
    bridge.close(db);
  });

  it('supports the index schema features: FTS5 with the trigram tokenizer', () => {
    const db = bridge.open('t3');
    bridge.exec(
      db,
      "CREATE VIRTUAL TABLE f USING fts5(title, body, tokenize = 'trigram case_sensitive 0')",
      [],
    );
    bridge.exec(db, 'INSERT INTO f VALUES(?, ?)', ['Alpha', 'Hello wonderful World']);
    const { cursor } = bridge.query(db, 'SELECT title FROM f WHERE f MATCH ?', ['"onderfu"']);
    expect(bridge.fetch(cursor, 10).rows).toEqual([['Alpha']]);
    bridge.close(db);
  });

  it('reports SQL errors as exceptions and rolls a transaction back', () => {
    const db = bridge.open('t4');
    bridge.exec(db, 'CREATE TABLE t(id INTEGER PRIMARY KEY)', []);
    bridge.exec(db, 'BEGIN', []);
    bridge.exec(db, 'INSERT INTO t VALUES(1)', []);
    expect(() => bridge.exec(db, 'INSERT INTO t VALUES(1)', [])).toThrow(/UNIQUE|constraint/i);
    bridge.exec(db, 'ROLLBACK', []);
    const { cursor } = bridge.query(db, 'SELECT count(*) FROM t', []);
    expect(bridge.fetch(cursor, 1).rows).toEqual([[0]]);
    bridge.close(db);
  });

  it('reports declared column types when the host provides them', () => {
    const typed = createBridge({
      openDatabase: (path) => bridgeDb(path),
      columnTypes: () => ['TIMESTAMP', ''],
    });
    const db = typed.open('t7');
    const { types } = typed.query(db, 'SELECT 1, 2', []);
    expect(types).toEqual(['TIMESTAMP', '']);
    typed.close(db);
    expect(bridge.query(bridge.open('t8'), 'SELECT 1', []).types).toEqual(['']);
  });

  it('knows which databases exist and forgets the deleted ones', () => {
    expect(bridge.exists('t6')).toBe(false);
    bridge.close(bridge.open('t6'));
    expect(bridge.exists('t6')).toBe(true);
    bridge.deleteDatabase('t6');
    expect(bridge.exists('t6')).toBe(false);
  });

  it('shares a named in-memory database between connections', () => {
    const a = bridge.open('t5');
    bridge.exec(a, 'CREATE TABLE t(x)', []);
    bridge.exec(a, 'INSERT INTO t VALUES(7)', []);
    const b = bridge.open('t5');
    const { cursor } = bridge.query(b, 'SELECT x FROM t', []);
    expect(bridge.fetch(cursor, 1).rows).toEqual([[7]]);
    bridge.close(a);
    bridge.close(b);
  });
});
