//go:build !js

package ai

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// DefaultSecrets keeps the key of the provider in the OS keychain (macOS Keychain, Windows
// Credential Manager, freedesktop Secret Service), as the refresh token of the session and the keys
// of the private vaults are (internal/auth, internal/crypto).
func DefaultSecrets() Secrets { return keychain{} }

const (
	keychainService = "MemoBrain Notes AI"
	keychainAccount = "provider-key"
)

type keychain struct{}

func (keychain) Set(key string) error { return keyring.Set(keychainService, keychainAccount, key) }

func (keychain) Get() (string, error) {
	v, err := keyring.Get(keychainService, keychainAccount)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return v, err
}

func (keychain) Delete() error {
	err := keyring.Delete(keychainService, keychainAccount)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
