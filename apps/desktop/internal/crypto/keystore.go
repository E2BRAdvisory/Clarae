package crypto

import (
	"errors"
	"sync"

	"github.com/zalando/go-keyring"
)

// KeyStore keeps the unwrapped VMK of a vault between runs, so a device that
// has been unlocked once does not ask for the passphrase again (§3.8.2
// "Cache locale"). The VMK never touches the disk in any other way.
type KeyStore interface {
	Set(account, secret string) error
	Get(account string) (string, error) // "" when absent
	Delete(account string) error
}

const keychainService = "MemoBrain Notes vault keys"

// KeychainStore uses the OS keychain (macOS Keychain, Windows Credential
// Manager, freedesktop Secret Service).
type KeychainStore struct{}

// Set implements KeyStore.
func (KeychainStore) Set(account, secret string) error {
	return keyring.Set(keychainService, account, secret)
}

// Get implements KeyStore.
func (KeychainStore) Get(account string) (string, error) {
	v, err := keyring.Get(keychainService, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return v, err
}

// Delete implements KeyStore.
func (KeychainStore) Delete(account string) error {
	err := keyring.Delete(keychainService, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
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
