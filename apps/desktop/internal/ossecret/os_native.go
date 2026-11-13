//go:build !js

package ossecret

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// OS is the keychain of the operating system (macOS Keychain, Windows Credential Manager,
// freedesktop Secret Service) through go-keyring. A browser has none (the browser build keeps its
// secrets in memory, see the keychain_js.go files).
type OS struct{}

var _ Backend = OS{}

// Get implements Backend.
func (OS) Get(service, account string) (string, error) {
	v, err := keyring.Get(service, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return v, err
}

// Set implements Backend.
func (OS) Set(service, account, secret string) error { return keyring.Set(service, account, secret) }

// Delete implements Backend.
func (OS) Delete(service, account string) error {
	err := keyring.Delete(service, account)
	if errors.Is(err, keyring.ErrNotFound) {
		return ErrNotFound
	}
	return err
}
