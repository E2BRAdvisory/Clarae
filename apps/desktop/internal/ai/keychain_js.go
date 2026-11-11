//go:build js

package ai

// DefaultSecrets keeps the key in memory: a browser has no OS keychain (and the WebAssembly core does
// not link this package anyway, internal/app bindings_ai_js.go).
func DefaultSecrets() Secrets { return &MemorySecrets{} }
