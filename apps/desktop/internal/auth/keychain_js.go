//go:build js

package auth

// defaultSecrets keeps secrets in memory: a browser has no OS keychain, and a hosted session keeps
// no refresh token anyway (the page owns the tokens).
func defaultSecrets() SecretStore { return NewMemoryStore() }
