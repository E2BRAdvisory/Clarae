//go:build js

package search

// defaultCacheBudget is smaller in the browser: the Go heap of the worker
// holds the cached bodies and, during a refresh, the next snapshot too (with
// the GC target at about twice the live heap), next to sqlite-wasm's memory.
const defaultCacheBudget int64 = 96 << 20
