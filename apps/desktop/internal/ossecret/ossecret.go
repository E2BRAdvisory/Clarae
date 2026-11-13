// Package ossecret is the access of the desktop to the secrets it keeps in the OS keychain: the
// refresh token of the session, the keys of the private vaults, the key of the AI provider. It
// exists for the rebrand (ADR-0052): the secrets are filed under the service names of 1.x, the OS
// keychain cannot be enumerated or renamed, and a signed-in user
// with private vaults must find everything working after the update, with nothing to type again.
//
// A Store reads from the current service and falls back to the legacy ones, copying what it finds
// to the current one; it writes to the current service and removes the legacy copy; it deletes
// from all of them (a delete that left the legacy copy would let the next read bring the secret
// back after a sign-out or after the lock of a vault).
package ossecret

import "errors"

// ErrNotFound is what a Backend answers when no secret is filed under (service, account).
var ErrNotFound = errors.New("secret not found")

// Backend is a keychain: the OS one (OS, native builds) or a fake in tests.
type Backend interface {
	// Get returns the secret, or ErrNotFound.
	Get(service, account string) (string, error)
	Set(service, account, secret string) error
	// Delete removes the secret; ErrNotFound when it was not there.
	Delete(service, account string) error
}

// Store is one kind of secret: a current service and the services that earlier versions used for it.
type Store struct {
	// Backend is the keychain (required).
	Backend Backend
	// Service is the current service name.
	Service string
	// Legacy are the service names of earlier versions, searched in this order.
	Legacy []string
}

// Get returns the secret of account; a secret that is not there is "" with no error. A secret that
// only a legacy service has is copied to the current service before it is returned. A failure to
// copy it does not fail the read (the secret is valid and the next read tries again); a keychain
// that cannot be read does, and it is never taken for a missing secret.
func (s Store) Get(account string) (string, error) {
	v, err := s.Backend.Get(s.Service, account)
	if err == nil {
		return v, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return "", err
	}
	for _, legacy := range s.Legacy {
		v, err := s.Backend.Get(legacy, account)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return "", err
		}
		_ = s.Backend.Set(s.Service, account, v)
		return v, nil
	}
	return "", nil
}

// Set files the secret under the current service and then removes the copies of the legacy
// services: they would be stale. The removal is best effort; Delete retries it.
func (s Store) Set(account, secret string) error {
	if err := s.Backend.Set(s.Service, account, secret); err != nil {
		return err
	}
	for _, legacy := range s.Legacy {
		_ = s.Backend.Delete(legacy, account)
	}
	return nil
}

// Delete removes the secret from the current service and from every legacy one, and answers the
// first failure after trying them all. A secret that is not there is not an error.
func (s Store) Delete(account string) error {
	var first error
	for _, service := range append([]string{s.Service}, s.Legacy...) {
		if err := s.Backend.Delete(service, account); err != nil && !errors.Is(err, ErrNotFound) && first == nil {
			first = err
		}
	}
	return first
}
