package ai

import "sync"

// Secrets keeps the key of the provider. It only goes in and is read by the requests of this package:
// nothing returns it to the frontend.
type Secrets interface {
	// Set stores the key.
	Set(key string) error
	// Get returns the key, "" when none is stored.
	Get() (string, error)
	// Delete forgets the key.
	Delete() error
}

// MemorySecrets is an in-memory Secrets (tests, and systems with no keychain).
type MemorySecrets struct {
	mu  sync.Mutex
	key string
}

// Set implements Secrets.
func (m *MemorySecrets) Set(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.key = key
	return nil
}

// Get implements Secrets.
func (m *MemorySecrets) Get() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.key, nil
}

// Delete implements Secrets.
func (m *MemorySecrets) Delete() error { return m.Set("") }
