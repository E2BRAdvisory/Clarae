// Package settingsdb holds the typed queries of the settings module, generated
// by sqlc (task gen-sqlc, services/cloud/sqlc.yaml) from
// internal/db/queries/settings.sql. The other files of this package are
// generated: change the SQL and regenerate, never edit them by hand. This file
// is written by hand; sqlc only rewrites db.go, models.go and settings.sql.go.
//
// Only package settings imports it (depguard rule settings-db in .golangci.yml,
// ADR-0033). Other modules go through the exported functions of package
// settings, which take a db.DBTX so they can join the caller's transaction. The
// tables each query file may touch are checked by
// internal/db/ownership_test.go.
package settingsdb
