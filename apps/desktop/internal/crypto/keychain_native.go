//go:build !js

package crypto

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// defaultStore keeps the VMKs of a desktop in the OS keychain.
func defaultStore() KeyStore { return KeychainStore{} }

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
