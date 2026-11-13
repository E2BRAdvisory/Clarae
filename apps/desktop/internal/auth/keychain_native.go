//go:build !js

package auth

import (
	"clarae/apps/desktop/internal/ossecret"
)

// defaultSecrets is where a desktop session keeps its refresh token: the OS keychain.
func defaultSecrets() SecretStore { return KeychainStore{} }

// KeychainStore uses the OS keychain (macOS Keychain, Windows Credential
// Manager, freedesktop Secret Service) via go-keyring (§2.5 "auth"). It reads the entry that
// 1.x filed under its own service name too (ossecret): a session survives the rebrand. The zero
// value uses the OS keychain; Backend replaces it (tests).
type KeychainStore struct{ Backend ossecret.Backend }

const keychainService = "Clarae notanda"

// legacyKeychainServices are the service names of 1.x: the refresh tokens are read from them and
// moved to the current one (dropped in 3.0).
var legacyKeychainServices = []string{"MemoBrain Notes"}

func (k KeychainStore) store() ossecret.Store {
	b := k.Backend
	if b == nil {
		b = ossecret.OS{}
	}
	return ossecret.Store{Backend: b, Service: keychainService, Legacy: legacyKeychainServices}
}

func refreshAccount(server string) string { return "refresh-token:" + server }

// Set implements SecretStore.
func (k KeychainStore) Set(server, refreshToken string) error {
	return k.store().Set(refreshAccount(server), refreshToken)
}

// Get implements SecretStore; a missing entry yields "" and no error.
func (k KeychainStore) Get(server string) (string, error) {
	return k.store().Get(refreshAccount(server))
}

// Delete implements SecretStore. It deletes the entry of 1.x as well: otherwise the next Get
// would bring the token of a signed-out session back.
func (k KeychainStore) Delete(server string) error {
	return k.store().Delete(refreshAccount(server))
}
