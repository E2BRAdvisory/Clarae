// Package db owns the PostgreSQL connection pool, transactions and schema
// migrations. Modules access data only through the sqlc-generated queries in
// dbgen, scoped to their own tables (spec §4.3).
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

	"nodus/services/cloud/internal/db/dbgen"
)

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

// Queries returns the generated query set bound to the pool.
func (d *DB) Queries() *dbgen.Queries { return dbgen.New(d.Pool) }

// WithTx runs fn inside a transaction, committing when fn returns nil and
// rolling back otherwise. The queries passed to fn are bound to the transaction.
func (d *DB) WithTx(ctx context.Context, fn func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(ctx, dbgen.New(tx), tx); err != nil {
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
