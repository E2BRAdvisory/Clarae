//go:build !js

package crypto

import (
	"clarae/apps/desktop/internal/ossecret"
)

// defaultStore keeps the VMKs of a desktop in the OS keychain.
func defaultStore() KeyStore { return KeychainStore{} }

const keychainService = "Clarae notanda vault keys"

// legacyKeychainServices are the service names of 1.x: the VMKs are read from them and moved to
// the current one, so that a private vault opens after the update with no recovery key typed
// (dropped in 3.0).
var legacyKeychainServices = []string{"MemoBrain Notes vault keys"}

// KeychainStore uses the OS keychain (macOS Keychain, Windows Credential
// Manager, freedesktop Secret Service). The zero value uses the OS keychain; Backend replaces it
// (tests).
type KeychainStore struct{ Backend ossecret.Backend }

func (k KeychainStore) store() ossecret.Store {
	b := k.Backend
	if b == nil {
		b = ossecret.OS{}
	}
	return ossecret.Store{Backend: b, Service: keychainService, Legacy: legacyKeychainServices}
}

// Set implements KeyStore.
func (k KeychainStore) Set(account, secret string) error { return k.store().Set(account, secret) }

// Get implements KeyStore.
func (k KeychainStore) Get(account string) (string, error) { return k.store().Get(account) }

// Delete implements KeyStore. It deletes the entry of 1.x as well: a key that stayed there would
// come back at the next Get, after the vault was locked or forgotten.
func (k KeychainStore) Delete(account string) error { return k.store().Delete(account) }
