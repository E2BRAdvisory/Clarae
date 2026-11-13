//go:build !js

package ai

import (
	"clarae/apps/desktop/internal/ossecret"
)

// DefaultSecrets keeps the key of the provider in the OS keychain (macOS Keychain, Windows
// Credential Manager, freedesktop Secret Service), as the refresh token of the session and the keys
// of the private vaults are (internal/auth, internal/crypto).
func DefaultSecrets() Secrets { return keychain{} }

const (
	keychainService = "Clarae notanda AI"
	keychainAccount = "provider-key"
)

// legacyKeychainServices are the service names of 1.x: the key is read from them and moved to the
// current one (dropped in 2.0).
var legacyKeychainServices = []string{"MemoBrain Notes AI"}

// keychain is the key of the provider in the OS keychain; backend replaces it (tests).
type keychain struct{ backend ossecret.Backend }

func (k keychain) store() ossecret.Store {
	b := k.backend
	if b == nil {
		b = ossecret.OS{}
	}
	return ossecret.Store{Backend: b, Service: keychainService, Legacy: legacyKeychainServices}
}

func (k keychain) Set(key string) error { return k.store().Set(keychainAccount, key) }

func (k keychain) Get() (string, error) { return k.store().Get(keychainAccount) }

// Delete removes the key from the current service and from the one of 1.x, which would bring it
// back at the next Get.
func (k keychain) Delete() error { return k.store().Delete(keychainAccount) }
