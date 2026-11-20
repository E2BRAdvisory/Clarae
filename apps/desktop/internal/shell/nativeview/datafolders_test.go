//go:build !js

package nativeview

import (
	"path/filepath"
	"testing"
)

func TestWebappsDir(t *testing.T) {
	if got := webappsDir(""); got != "" {
		t.Errorf("webappsDir(\"\") = %q, want none", got)
	}
	if got := webappsDir("relative/data"); got != "" {
		t.Errorf("webappsDir(relative) = %q, want none", got)
	}
	base := t.TempDir()
	want := filepath.Join(base, "webapps")
	for _, in := range []string{base, base + string(filepath.Separator), filepath.Join(base, "x", "..")} {
		if got := webappsDir(in); got != want {
			t.Errorf("webappsDir(%q) = %q, want %q", in, got, want)
		}
	}
	// The same folder as the one derived from the profile of the web view of the application.
	if a, b := webappsDir(base), webappsRoot(filepath.Join(base, "webview")); a != b {
		t.Errorf("webappsDir %q and webappsRoot %q name different folders", a, b)
	}
}
