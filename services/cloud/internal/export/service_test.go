package export

import "testing"

func TestSkippedLeavesOutDeviceSpecificFiles(t *testing.T) {
	for p, want := range map[string]bool{
		"Notes/a.md":                  false,
		".memobrain/editor.json":      false, // user settings are part of the vault
		".memobrain/workspace.json":   true,
		".memobrain/index.db":         true,
		".memobrain/cache/x.svg":      true,
		".memobrain/snapshots/1/a.md": true,
		"Notes/.DS_Store":             true,
		"Notes/.memobrain/cache/x":    false,
	} {
		if got := skipped(p); got != want {
			t.Errorf("skipped(%q) = %v, want %v", p, got, want)
		}
	}
}
