package ossecret

import "sync"

// Memory is a Backend that keeps the secrets in memory: the keychain the tests of the packages
// that use a Store put under it.
type Memory struct {
	mu    sync.Mutex
	items map[[2]string]string
}

var _ Backend = (*Memory)(nil)

// NewMemory returns an empty Memory.
func NewMemory() *Memory { return &Memory{items: map[[2]string]string{}} }

// Get implements Backend.
func (m *Memory) Get(service, account string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.items[[2]string{service, account}]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

// Set implements Backend.
func (m *Memory) Set(service, account, secret string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items[[2]string{service, account}] = secret
	return nil
}

// Delete implements Backend.
func (m *Memory) Delete(service, account string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.items[[2]string{service, account}]; !ok {
		return ErrNotFound
	}
	delete(m.items, [2]string{service, account})
	return nil
}
