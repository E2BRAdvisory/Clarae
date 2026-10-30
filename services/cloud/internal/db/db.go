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
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
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

// Open connects to PostgreSQL and verifies the connection.
func Open(ctx context.Context, url string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
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

// Migrate applies every pending migration embedded in this package.
func (d *DB) Migrate(ctx context.Context) error {
	sqlDB := stdlib.OpenDBFromPool(d.Pool)
	defer func(db *sql.DB) { _ = db.Close() }(sqlDB)

	fsys, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, sqlDB, fsys)
	if err != nil {
		return fmt.Errorf("goose provider: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// IsUniqueViolation reports whether err is a PostgreSQL unique constraint violation.
func IsUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}
