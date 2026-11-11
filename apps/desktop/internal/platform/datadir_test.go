package platform

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// dbusNames is the validation Wails v3.1.0 applies to SingleInstance.UniqueID on Linux
// (pkg/application/single_instance_linux.go), copied here because that file is Linux-only and needs
// D-Bus. An id it refuses makes the application exit at startup.
func dbusNames(uniqueID string) error {
	for _, element := range strings.Split(uniqueID, ".") {
		if element == "" {
			return fmt.Errorf("UniqueID %q has an empty element", uniqueID)
		}
		if element[0] >= '0' && element[0] <= '9' {
			return fmt.Errorf("UniqueID %q has an element starting with a digit (%q)", uniqueID, element)
		}
		for _, r := range element {
			if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
				continue
			}
			return fmt.Errorf("UniqueID %q contains %q", uniqueID, r)
		}
	}
	return nil
}

func randomDataDirs(t *testing.T, n int) []string {
	t.Helper()
	seen := map[string]bool{}
	var out []string
	for len(out) < n {
		var b [12]byte
		if _, err := rand.Read(b[:]); err != nil {
			t.Fatal(err)
		}
		h := hex.EncodeToString(b[:])
		dir := filepath.Join("/home", "u"+h[:6], ".config", "MemoBrain Notes", h[6:])
		if !seen[dir] {
			seen[dir] = true
			out = append(out, dir)
		}
	}
	return out
}

// Linux: 10 of the 16 leading hex digits are decimal, so the id of v2 was refused for about 62% of
// the data directories. 1000 random ones must all pass now, with distinct ids.
func TestInstanceIDIsAValidDBusNameForEveryDataDir(t *testing.T) {
	ids := map[string]string{}
	for _, dir := range randomDataDirs(t, 1000) {
		id := InstanceID(dir)
		if err := dbusNames(id); err != nil {
			t.Fatalf("data dir %q: %v", dir, err)
		}
		if !strings.HasPrefix(id, "dev.memobrain.desktop.i") || len(id) != len("dev.memobrain.desktop.i")+16 {
			t.Fatalf("unexpected shape %q", id)
		}
		if prev, dup := ids[id]; dup {
			t.Fatalf("data dirs %q and %q share the id %q", prev, dir, id)
		}
		ids[id] = dir
	}
}

// The rule itself is the one that rejected the old shape: guards the test against a copy that
// accepts everything.
func TestDBusRuleRejectsADigitLeadingElement(t *testing.T) {
	if dbusNames("dev.memobrain.desktop.0123456789abcdef") == nil {
		t.Fatal("a digit-leading element must be refused")
	}
	if dbusNames("dev.memobrain.desktop.i0123456789abcdef") != nil {
		t.Fatal("the new shape must be accepted")
	}
}

func TestInstanceIDIsPerDataDir(t *testing.T) {
	if InstanceID("/data/a") == InstanceID("/data/b") {
		t.Fatal("two data dirs share an id")
	}
	if InstanceID("/data/a") != InstanceID("/data/a/") || InstanceID("/data/a") != InstanceID("/data/./a") {
		t.Fatal("the id must not depend on how the path is spelt")
	}
}

func TestInstanceKeyIsDeterministicAndPerID(t *testing.T) {
	a, b := InstanceID("/data/a"), InstanceID("/data/b")
	again := InstanceKey(a)
	if InstanceKey(a) != again {
		t.Fatal("the key must be derived, not random")
	}
	if InstanceKey(a) == InstanceKey(b) {
		t.Fatal("two instances share a key")
	}
	if InstanceKey(a) == ([32]byte{}) {
		t.Fatal("a zero key means no encryption")
	}
}
