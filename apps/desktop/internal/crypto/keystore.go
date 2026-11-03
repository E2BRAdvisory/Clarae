package crypto

import "sync"

// KeyStore keeps the unwrapped VMK of a vault between runs, so a device that
// has been unlocked once does not ask for the passphrase again (§3.8.2
// "Cache locale"). The VMK never touches the disk in any other way.
type KeyStore interface {
	Set(account, secret string) error
	Get(account string) (string, error) // "" when absent
	Delete(account string) error
}

// MemoryStore is an in-memory KeyStore for tests and headless systems.
type MemoryStore struct {
	mu sync.Mutex
	m  map[string]string
}

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore { return &MemoryStore{m: map[string]string{}} }

// Set implements KeyStore.
func (s *MemoryStore) Set(a, v string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[a] = v
	return nil
}

// Get implements KeyStore.
func (s *MemoryStore) Get(a string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[a], nil
}

// Delete implements KeyStore.
func (s *MemoryStore) Delete(a string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, a)
	return nil
}
