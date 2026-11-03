//go:build js

package crypto

// defaultStore keeps the VMKs in memory: a browser has no OS keychain (the web host passes a
// MemoryStore anyway, app.New).
func defaultStore() KeyStore { return NewMemoryStore() }
