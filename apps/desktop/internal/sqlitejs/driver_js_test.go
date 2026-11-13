//go:build js && wasm

package sqlitejs_test

import (
	"bytes"
	"context"
	"database/sql"
	"testing"

	_ "clarae/apps/desktop/internal/sqlitejs"
)

func open(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/t.db?_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestRoundTripsEveryValueKind(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER, f REAL, s TEXT, b BLOB, nul TEXT)`); err != nil {
		t.Fatal(err)
	}
	const nanos = int64(1761750000123456789) // a file mtime in ns: beyond 2^53
	res, err := db.ExecContext(ctx, `INSERT INTO t(n, f, s, b, nul) VALUES(?, ?, ?, ?, ?)`, nanos, 2.5, "héllo ✓", []byte{0, 1, 255}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if id, _ := res.LastInsertId(); id != 1 {
		t.Fatalf("LastInsertId = %d, want 1", id)
	}
	var (
		n   int64
		f   float64
		s   string
		b   []byte
		nul sql.NullString
	)
	if err := db.QueryRowContext(ctx, `SELECT n, f, s, b, nul FROM t WHERE id = ?`, 1).Scan(&n, &f, &s, &b, &nul); err != nil {
		t.Fatal(err)
	}
	if n != nanos || f != 2.5 || s != "héllo ✓" || !bytes.Equal(b, []byte{0, 1, 255}) || nul.Valid {
		t.Fatalf("got n=%d f=%v s=%q b=%v nul=%v", n, f, s, b, nul)
	}
}

// goose and sqlc write "$1"-style placeholders: they must bind by position.
func TestDollarPlaceholdersBindByPosition(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	for _, q := range []string{
		`CREATE TABLE v(version_id INTEGER NOT NULL, is_applied INTEGER NOT NULL, tstamp TIMESTAMP DEFAULT (datetime('now')))`,
		`INSERT INTO v(version_id, is_applied) VALUES(0, 1)`,
		`INSERT INTO v(version_id, is_applied) VALUES(7, 1)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	var applied bool
	if err := db.QueryRowContext(ctx, `SELECT is_applied FROM v WHERE version_id=$1 ORDER BY tstamp DESC LIMIT 1`, int64(0)).Scan(&applied); err != nil {
		t.Fatalf("version 0 not found: %v", err)
	}
	if !applied {
		t.Fatal("is_applied = false")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO v(version_id, is_applied) VALUES($1, $2)`, int64(9), true); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM v WHERE version_id = $1 AND is_applied = $2`, int64(9), true).Scan(&count); err != nil || count != 1 {
		t.Fatalf("count = %d, err = %v", count, err)
	}
}

func TestTransactionsCommitAndRollBack(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE t(id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO t VALUES(1)`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	tx, _ = db.BeginTx(ctx, nil)
	if _, err := tx.ExecContext(ctx, `INSERT INTO t VALUES(2)`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var ids []int
	rows, err := db.QueryContext(ctx, `SELECT id FROM t`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if len(ids) != 1 || ids[0] != 2 {
		t.Fatalf("ids = %v, want [2]", ids)
	}
}

func TestLargeResultsArriveInBatches(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)`); err != nil {
		t.Fatal(err)
	}
	tx, _ := db.BeginTx(ctx, nil)
	for i := 0; i < 1000; i++ {
		if _, err := tx.ExecContext(ctx, `INSERT INTO t(v) VALUES(?)`, "row"); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(ctx, `SELECT id FROM t ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	n := 0
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		n++
		if id != n {
			t.Fatalf("row %d has id %d", n, id)
		}
	}
	if n != 1000 {
		t.Fatalf("read %d rows, want 1000", n)
	}
}

func TestSQLErrorsSurface(t *testing.T) {
	db := open(t)
	if _, err := db.Exec(`SELECT * FROM missing_table`); err == nil {
		t.Fatal("expected an error")
	}
}

// A database outlives its connections, as a file does: "reopen" must see what the first
// connection wrote.
func TestDataSurvivesReopen(t *testing.T) {
	dsn := "file:" + t.TempDir() + "/r.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	first, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Exec(`CREATE TABLE t(x INTEGER)`); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Exec(`INSERT INTO t VALUES(41)`); err != nil {
		t.Fatal(err)
	}
	_ = first.Close()

	second, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = second.Close() }()
	var x int
	if err := second.QueryRow(`SELECT x FROM t`).Scan(&x); err != nil || x != 41 {
		t.Fatalf("x = %d, err = %v", x, err)
	}
}
