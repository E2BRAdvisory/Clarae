//go:build !js

package ai

import (
	"testing"

	"clarae/apps/desktop/internal/ossecret"
)

func TestKeychainReadsTheKeyOf1xAndDeletesItEverywhere(t *testing.T) {
	kc := ossecret.NewMemory()
	if err := kc.Set(legacyKeychainServices[0], keychainAccount, "sk-1x"); err != nil {
		t.Fatal(err)
	}
	k := keychain{backend: kc}

	if got, err := k.Get(); err != nil || got != "sk-1x" {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if v, err := kc.Get(keychainService, keychainAccount); err != nil || v != "sk-1x" {
		t.Fatalf("the key was not moved to %q: %q, %v", keychainService, v, err)
	}

	if err := kc.Set(legacyKeychainServices[0], keychainAccount, "sk-1x"); err != nil {
		t.Fatal(err)
	}
	if err := k.Delete(); err != nil {
		t.Fatal(err)
	}
	if got, err := k.Get(); err != nil || got != "" {
		t.Fatalf("after Delete, Get = %q, %v", got, err)
	}
}

// The names are those 1.x filed its secrets under: a different spelling would sign every user out
// and lock every private vault, with nothing in the tests to say why.
func TestLegacyKeychainServiceIsTheOneOf1x(t *testing.T) {
	if len(legacyKeychainServices) != 1 || legacyKeychainServices[0] != "MemoBrain Notes AI" {
		t.Fatalf("legacyKeychainServices = %q", legacyKeychainServices)
	}
}
