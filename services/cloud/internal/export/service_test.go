package export

import "testing"

func TestSkippedLeavesOutDeviceSpecificFiles(t *testing.T) {
	for p, want := range map[string]bool{
		"Notes/a.md":              false,
		".nodus/editor.json":      false, // user settings are part of the vault
		".nodus/workspace.json":   true,
		".nodus/index.db":         true,
		".nodus/cache/x.svg":      true,
		".nodus/snapshots/1/a.md": true,
		"Notes/.DS_Store":         true,
		"Notes/.nodus/cache/x":    false,
	} {
		if got := skipped(p); got != want {
			t.Errorf("skipped(%q) = %v, want %v", p, got, want)
		}
	}
}
