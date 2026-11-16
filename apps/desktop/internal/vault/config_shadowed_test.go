package vault

import (
	"errors"
	"testing"

	"clarae/shared/hashing"
)

func TestRemoveShadowedConfig(t *testing.T) {
	fs := newTestFS(t)
	put(t, fs, cfgLegacy+"/editor.json", "legacy")
	put(t, fs, cfgLegacy+"/templates/sub/daily.md", "# daily")
	put(t, fs, cfgCurrent+"/editor.json", "current")
	hash := func(s string) string { return hashing.Sum([]byte(s)).Hex() }

	// A file changed since the engine saw it, or a call without its hash, never removes anything.
	if removed, err := fs.RemoveShadowedConfig(cfgLegacy+"/editor.json", hash("other"), false); !errors.Is(err, ErrHashMismatch) || removed {
		t.Fatalf("changed file: %v %v", removed, err)
	}
	if removed, err := fs.RemoveShadowedConfig(cfgLegacy+"/editor.json", "", false); err != nil || removed {
		t.Fatalf("no hash: %v %v", removed, err)
	}
	// The current folder and the local-only names are never touched.
	if removed, err := fs.RemoveShadowedConfig(cfgCurrent+"/editor.json", hash("current"), false); err != nil || removed {
		t.Fatalf("current folder: %v %v", removed, err)
	}
	if !has(fs, cfgLegacy+"/editor.json") || content(t, fs, cfgCurrent+"/editor.json") != "current" {
		t.Fatal("a file was touched")
	}

	// With keepCopy the version goes to the trash, with its path.
	if removed, err := fs.RemoveShadowedConfig(cfgLegacy+"/editor.json", hash("legacy"), true); err != nil || !removed {
		t.Fatalf("keep a copy: %v %v", removed, err)
	}
	if has(fs, cfgLegacy+"/editor.json") || content(t, fs, ".trash/"+cfgLegacy+"/editor.json") != "legacy" {
		t.Fatal("the version was not kept in the trash")
	}
	// Without it the file is deleted, and the folders it leaves empty go with it.
	if removed, err := fs.RemoveShadowedConfig(cfgLegacy+"/templates/sub/daily.md", hash("# daily"), false); err != nil || !removed {
		t.Fatalf("delete: %v %v", removed, err)
	}
	if has(fs, cfgLegacy) || has(fs, ".trash/"+cfgLegacy+"/templates") {
		t.Fatal("the former folder is still there, or the deleted file went to the trash")
	}
	// Gone is not an error.
	if removed, err := fs.RemoveShadowedConfig(cfgLegacy+"/editor.json", hash("legacy"), false); err != nil || removed {
		t.Fatalf("gone: %v %v", removed, err)
	}
}
