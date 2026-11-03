//go:build !js

package auth

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// defaultSecrets is where a desktop session keeps its refresh token: the OS keychain.
func defaultSecrets() SecretStore { return KeychainStore{} }

// KeychainStore uses the OS keychain (macOS Keychain, Windows Credential
// Manager, freedesktop Secret Service) via go-keyring (§2.5 "auth").
type KeychainStore struct{}

const keychainService = "MemoBrain Notes"

// Set implements SecretStore.
func (KeychainStore) Set(server, refreshToken string) error {
	return keyring.Set(keychainService, "refresh-token:"+server, refreshToken)
}

// Get implements SecretStore; a missing entry yields "" and no error.
func (KeychainStore) Get(server string) (string, error) {
	v, err := keyring.Get(keychainService, "refresh-token:"+server)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return v, err
}

// Delete implements SecretStore.
func (KeychainStore) Delete(server string) error {
	err := keyring.Delete(keychainService, "refresh-token:"+server)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
