//go:build !js

package auth

import (
	"testing"

	"clarae/apps/desktop/internal/ossecret"
)

// The session of 1.x: its refresh token is in the keychain under the service of 1.x. After the
// update the user is still signed in, and a sign-out leaves nothing that a later start could pick up.
func TestKeychainStoreReadsTheTokenOf1xAndDeletesItEverywhere(t *testing.T) {
	kc := ossecret.NewMemory()
	const server = "https://cloud.example.org"
	if err := kc.Set(legacyKeychainServices[0], "refresh-token:"+server, "rt-1x"); err != nil {
		t.Fatal(err)
	}
	s := KeychainStore{Backend: kc}

	got, err := s.Get(server)
	if err != nil || got != "rt-1x" {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if v, err := kc.Get(keychainService, "refresh-token:"+server); err != nil || v != "rt-1x" {
		t.Fatalf("the token was not moved to %q: %q, %v", keychainService, v, err)
	}

	// The token rotates: the new one is the only copy.
	if err := s.Set(server, "rt-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := kc.Get(legacyKeychainServices[0], "refresh-token:"+server); err == nil {
		t.Fatal("the stale token of 1.x is still in the keychain")
	}

	// Sign-out, with the old entry back (the other version signed in again in the meantime).
	if err := kc.Set(legacyKeychainServices[0], "refresh-token:"+server, "rt-old"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(server); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Get(server); err != nil || got != "" {
		t.Fatalf("after Delete, Get = %q, %v", got, err)
	}
}

// The names are those 1.x filed its secrets under: a different spelling would sign every user out
// and lock every private vault, with nothing in the tests to say why.
func TestLegacyKeychainServiceIsTheOneOf1x(t *testing.T) {
	if len(legacyKeychainServices) != 1 || legacyKeychainServices[0] != "MemoBrain Notes" {
		t.Fatalf("legacyKeychainServices = %q", legacyKeychainServices)
	}
}
