//go:build !js

package crypto

import (
	"testing"

	"clarae/apps/desktop/internal/ossecret"
)

// The VMK of a private vault of 1.x is in the keychain under the service of 1.x: the vault must
// open after the update with nothing typed, and once locked (or forgotten) it must stay locked.
func TestKeychainStoreReadsTheKeyOf1xAndDeletesItEverywhere(t *testing.T) {
	kc := ossecret.NewMemory()
	if err := kc.Set(legacyKeychainServices[0], "vault-1", "vmk"); err != nil {
		t.Fatal(err)
	}
	s := KeychainStore{Backend: kc}

	if got, err := s.Get("vault-1"); err != nil || got != "vmk" {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if v, err := kc.Get(keychainService, "vault-1"); err != nil || v != "vmk" {
		t.Fatalf("the key was not moved to %q: %q, %v", keychainService, v, err)
	}

	if err := kc.Set(legacyKeychainServices[0], "vault-1", "vmk"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("vault-1"); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Get("vault-1"); err != nil || got != "" {
		t.Fatalf("after Delete, Get = %q, %v: the key of a locked vault came back", got, err)
	}
}

// The names are those 1.x filed its secrets under: a different spelling would sign every user out
// and lock every private vault, with nothing in the tests to say why.
func TestLegacyKeychainServiceIsTheOneOf1x(t *testing.T) {
	if len(legacyKeychainServices) != 1 || legacyKeychainServices[0] != "MemoBrain Notes vault keys" {
		t.Fatalf("legacyKeychainServices = %q", legacyKeychainServices)
	}
}
