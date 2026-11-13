// Package sqlitejs is a database/sql driver (registered as "sqlite") for the Go core compiled to
// WebAssembly (ADR-0030). It forwards every statement, synchronously, to the JavaScript bridge
// `globalThis.__claraeSQLite` (packages/sqlite-bridge), which runs sqlite-wasm in the same Web
// Worker. On any other platform the package is empty: the desktop uses modernc.org/sqlite.
package sqlitejs
