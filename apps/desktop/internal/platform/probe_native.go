//go:build !js

package platform

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // database/sql driver "sqlite"
)

// errInUse is what quiesceDatabase answers when another connection has the database open.
var errInUse = errors.New("the database is open in another process")

// quiesceDatabase says whether nobody else has the SQLite database at path open and, if nobody
// does, leaves it closed and complete: its write-ahead log folded into the file and removed, so
// that the file alone is the whole database and can be moved.
//
// The probe is the switch of the journal mode from WAL to DELETE with no wait (busy_timeout 0).
// SQLite takes the log away only when the connection is the last one: with another connection open
// the database is busy and the mode stays WAL. That holds whatever process, version of the
// application or toolkit holds the other connection (a lock file of the toolkit would not tell the
// 1.3 instances of Wails v2 from the 1.4 ones of v3: their instance ids differ), and an idle
// connection counts: the pool of the 1.x application keeps one open for as long as it runs.
// errInUse is the answer for that; any other error is the database not being readable at all.
func quiesceDatabase(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	slash := filepath.ToSlash(abs)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash // a drive letter: the path of the URI is "/C:/x"
	}
	dsn := (&url.URL{Scheme: "file", Path: slash, RawQuery: url.Values{
		"mode":    {"rw"}, // never create it
		"_pragma": {"busy_timeout(0)"},
	}.Encode()}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=DELETE").Scan(&mode); err != nil {
		if isBusy(err) {
			return errInUse
		}
		return fmt.Errorf("probe %s: %w", abs, err)
	}
	if !strings.EqualFold(mode, "delete") {
		return errInUse // the mode did not change: another connection holds the log
	}
	return nil
}

// isBusy reports whether err is SQLITE_BUSY or SQLITE_LOCKED (the driver's errors carry the code of
// SQLite; the text is the fallback).
func isBusy(err error) bool {
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		switch coded.Code() & 0xff {
		case 5, 6: // SQLITE_BUSY, SQLITE_LOCKED
			return true
		}
	}
	return strings.Contains(err.Error(), "database is locked")
}
