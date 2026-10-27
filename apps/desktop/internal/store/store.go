// Package store opens the local SQLite databases (pure Go, modernc.org/sqlite)
// and applies their embedded migrations:
//
//   - app.db   (data dir)        recent vaults, application preferences
//   - index.db (<vault>/.memobrain/) derived search index, rebuildable at any time
//   - sync.db  (<vault>/.memobrain/) synchronization state (M2)
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"

	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite" // database/sql driver "sqlite"
)

//go:embed migrations/app/*.sql migrations/index/*.sql migrations/sync/*.sql
var migrations embed.FS

// Kind selects a database schema.
type Kind string

// Database kinds.
const (
	KindApp   Kind = "app"
	KindIndex Kind = "index"
	KindSync  Kind = "sync"
)

// Open opens (creating if needed) the SQLite file at path, enables WAL and
// foreign keys, and migrates it to the latest schema of its kind.
func Open(ctx context.Context, path string, kind Kind) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?" + url.Values{
		"_pragma": []string{"journal_mode(WAL)", "busy_timeout(5000)", "foreign_keys(ON)", "synchronous(NORMAL)"},
	}.Encode()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite serializes writers; one connection avoids SQLITE_BUSY churn.
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	if err := migrate(ctx, db, kind); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func migrate(ctx context.Context, db *sql.DB, kind Kind) error {
	fsys, err := fs.Sub(migrations, "migrations/"+string(kind))
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectSQLite3, db, fsys,
		goose.WithTableName("schema_"+string(kind)))
	if err != nil {
		return fmt.Errorf("goose provider (%s): %w", kind, err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("migrate %s: %w", kind, err)
	}
	return nil
}

// Reset deletes the database files (main, -wal, -shm). Used by "Rebuild
// index": index.db is derived and may be thrown away at any time.
func Reset(path string) error {
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err := os.Remove(path + suffix); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
