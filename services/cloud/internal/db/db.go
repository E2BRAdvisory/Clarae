// Package db owns the PostgreSQL connection pool, transactions and schema
// migrations. Each module accesses its own tables through its own
// sqlc-generated package (internal/<module>/<module>db) and reaches the tables
// of others only through their exported functions (spec §4.3, ADR-0033).
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

// DBTX is what every generated query package runs on: the pool or a
// transaction. Functions a module exports for others take a DBTX, so a caller
// can include them in its own transaction.
type DBTX interface {
	Exec(context.Context, string, ...interface{}) (pgconn.CommandTag, error)
	Query(context.Context, string, ...interface{}) (pgx.Rows, error)
	QueryRow(context.Context, string, ...interface{}) pgx.Row
}

//go:embed migrations/*.sql
var migrations embed.FS

// DB wraps the pool and exposes query and transaction helpers.
type DB struct {
	Pool *pgxpool.Pool
}

// minPoolConns is the pool size floor when DATABASE_URL does not set
// pool_max_conns: the pgx default, max(4, CPUs), is too small for the API and
// the worker sharing one process (--role=all) on a small machine.
const minPoolConns = 8

// Open connects to PostgreSQL and verifies the connection. The pool size is
// the pool_max_conns parameter of the URL, or at least minPoolConns.
func Open(ctx context.Context, url string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	if !strings.Contains(url, "pool_max_conns") && cfg.MaxConns < minPoolConns {
		cfg.MaxConns = minPoolConns
	}
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 10 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &DB{Pool: pool}, nil
}

// Close releases the pool.
func (d *DB) Close() { d.Pool.Close() }

// Ping is used by readiness checks.
func (d *DB) Ping(ctx context.Context) error { return d.Pool.Ping(ctx) }

// WithTx runs fn inside a transaction, committing when fn returns nil and
// rolling back otherwise. fn binds its module's queries to tx and passes tx to
// the functions of other modules it calls.
func (d *DB) WithTx(ctx context.Context, fn func(ctx context.Context, tx pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// migrationLockID is the advisory lock that serialises migrations across
// replicas (an arbitrary constant, distinct from the job locks).
const migrationLockID int64 = 7_300_001

// Migrate applies every pending migration embedded in this package. Several
// API replicas start together (Helm runs two or more): a Postgres session
// advisory lock makes them migrate one at a time, and the ones that wait find
// nothing left to do.
func (d *DB) Migrate(ctx context.Context) error {
	sqlDB := stdlib.OpenDBFromPool(d.Pool)
	defer func(db *sql.DB) { _ = db.Close() }(sqlDB)

	fsys, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	// Wait up to 10 minutes (every 2 s) for another replica's migration.
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockID(migrationLockID), lock.WithLockTimeout(2, 300))
	if err != nil {
		return fmt.Errorf("migration lock: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, fsys, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("goose provider: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// ErrSchemaBehind reports a database schema older than this binary's migrations.
var ErrSchemaBehind = errors.New("database schema is older than this binary")

// SchemaVersion returns the version of the database schema (0 before the
// first migration) and the version this binary's migrations reach. It only
// reads: the worker checks the schema without ever migrating it.
func (d *DB) SchemaVersion(ctx context.Context) (current, expected int64, err error) {
	expected, err = latestMigration()
	if err != nil {
		return 0, 0, err
	}
	var table *string
	if err := d.Pool.QueryRow(ctx, "SELECT to_regclass('goose_db_version')::text").Scan(&table); err != nil {
		return 0, expected, err
	}
	if table == nil {
		return 0, expected, nil
	}
	err = d.Pool.QueryRow(ctx, "SELECT COALESCE(MAX(version_id), 0) FROM goose_db_version WHERE is_applied").Scan(&current)
	return current, expected, err
}

// CheckSchema fails with ErrSchemaBehind while the database lacks migrations
// this binary needs. A newer schema is accepted: during a rolling upgrade the
// new API migrates while old workers still run, and migrations stay
// backwards compatible for one release.
func (d *DB) CheckSchema(ctx context.Context) error {
	current, expected, err := d.SchemaVersion(ctx)
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if current < expected {
		return fmt.Errorf("%w: database at %d, binary needs %d", ErrSchemaBehind, current, expected)
	}
	return nil
}

// WaitForSchema blocks until CheckSchema succeeds, retrying with a backoff
// that doubles from first up to max; onRetry (optional) is told about every
// failed attempt. It is how the worker waits for the API to migrate.
func (d *DB) WaitForSchema(ctx context.Context, first, max time.Duration, onRetry func(err error, next time.Duration)) error {
	delay := first
	for {
		err := d.CheckSchema(ctx)
		if err == nil {
			return nil
		}
		if onRetry != nil {
			onRetry(err, delay)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for the database schema: %w (last error: %w)", ctx.Err(), err)
		case <-time.After(delay):
		}
		delay = min(delay*2, max)
	}
}

// latestMigration is the highest version among the embedded migrations
// (goose file names start with the version: 0007_retention_fixes.sql).
func latestMigration() (int64, error) {
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return 0, err
	}
	var latest int64
	for _, e := range entries {
		num, _, ok := strings.Cut(e.Name(), "_")
		if !ok || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		v, err := strconv.ParseInt(num, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("migration %s: %w", e.Name(), err)
		}
		latest = max(latest, v)
	}
	if latest == 0 {
		return 0, errors.New("no embedded migrations")
	}
	return latest, nil
}

// IsUniqueViolation reports whether err is a PostgreSQL unique constraint violation.
func IsUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}
