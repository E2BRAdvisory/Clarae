// Package store opens the local SQLite databases (pure Go, modernc.org/sqlite; sqlite-wasm in the
// browser build, see driver_js.go)
// and applies their embedded migrations:
//
//   - app.db   (data dir)        recent vaults, application preferences
//   - index.db (<vault>/.clarae/) derived search index, rebuildable at any time
//   - sync.db  (<vault>/.clarae/) synchronization state (M2)
package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/pressly/goose/v3"
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
	dsn, err := fileURI(path, url.Values{
		"_pragma": []string{"journal_mode(WAL)", "busy_timeout(5000)", "foreign_keys(ON)", "synchronous(NORMAL)"},
	})
	if err != nil {
		return nil, err
	}
	warnLegacy(path)
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

// fileURI returns the SQLite URI filename that opens path with the given query parameters. The
// path is escaped: SQLite ends the path of a "file:" URI at the first '?' or '#' and decodes %HH
// sequences, so a vault folder named "Notes #1" must not be passed verbatim. On Windows "C:\x"
// becomes "file:///C:/x".
func fileURI(path string, query url.Values) (string, error) {
	abs := path
	if !filepath.IsAbs(abs) {
		var err error
		if abs, err = filepath.Abs(abs); err != nil {
			return "", err
		}
	}
	return slashURI(filepath.ToSlash(abs), query), nil
}

// slashURI is fileURI for an absolute path already in slash form ("/v/x" or "C:/v/x").
func slashURI(p string, query url.Values) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // drive letter: the URI path is "/C:/x"
	}
	return (&url.URL{Scheme: "file", Path: p, RawQuery: query.Encode()}).String()
}

// legacyURIPath returns the file the store opened for path before the DSN was escaped (M12): the
// path went verbatim into "file:<path>?…", so SQLite stopped at the first '?' or '#' and decoded
// %HH sequences (a %00 ends the path as well).
func legacyURIPath(path string) string {
	var b strings.Builder
	for i := 0; i < len(path); i++ {
		c := path[i]
		switch {
		case c == '?' || c == '#':
			return b.String()
		case c == '%' && i+2 < len(path) && isHex(path[i+1]) && isHex(path[i+2]):
			octet := unhex(path[i+1])<<4 | unhex(path[i+2])
			if octet == 0 {
				return b.String()
			}
			b.WriteByte(octet)
			i += 2
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func isHex(c byte) bool {
	return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}

func unhex(c byte) byte {
	switch {
	case c <= '9':
		return c - '0'
	case c <= 'F':
		return c - 'A' + 10
	default:
		return c - 'a' + 10
	}
}

// warnLegacy logs where an older build put the database at path, when that differs from path and
// a database is still there. The file is left alone: several vaults may have shared it. index.db
// is rebuilt on its own; a fresh sync.db shows the vault as not linked.
func warnLegacy(path string) {
	if legacy, ok := legacyDatabase(path); ok {
		slog.Warn("store: an older build kept this database at another path; that file is no longer used for it and was left in place",
			"path", path, "legacy_path", legacy)
	}
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
func Reset(path string) error { return removeDatabase(path) }
