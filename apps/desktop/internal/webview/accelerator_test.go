package webview

import (
	"errors"
	"regexp"
	"testing"
)

func TestParseAccelerator(t *testing.T) {
	good := map[string]string{
		"cmd+w":             "cmd+w",
		"CMD+W":             "cmd+w",
		"shift+cmd+p":       "shift+cmd+p",
		"cmd+shift+p":       "shift+cmd+p",
		"ctrl+tab":          "ctrl+tab",
		"cmd+alt+left":      "alt+cmd+left",
		"ctrl+shift+alt+1":  "ctrl+alt+shift+1",
		"cmd+,":             "cmd+,",
		"cmd+]":             "cmd+]",
		"cmd++":             "cmd+plus",
		"cmd+plus":          "cmd+plus",
		"f5":                "f5",
		"alt+f4":            "alt+f4",
		"cmd+f12":           "cmd+f12",
		"ctrl+pagedown":     "ctrl+pagedown",
		"cmd+shift+z+":      "", // see below
		"cmd+enter":         "cmd+enter",
		"cmd+backspace":     "cmd+backspace",
		"ctrl+alt+delete":   "ctrl+alt+delete",
		"cmd+shift+[":       "shift+cmd+[",
		"cmd+space":         "cmd+space",
		"cmd+escape":        "cmd+escape",
		"ctrl+/":            "ctrl+/",
		"cmd+f20":           "cmd+f20",
		"cmd+9":             "cmd+9",
		"cmd+shift+arrow":   "",
		"cmd+f21":           "",
		"cmd+alt+shift+cmd": "",
	}
	for in, want := range good {
		got, err := ParseAccelerator(in)
		if want == "" {
			if err == nil || !errors.Is(err, ErrAccelerator) {
				t.Errorf("ParseAccelerator(%q) = %q, %v; want ErrAccelerator", in, got, err)
			}
			continue
		}
		if err != nil || got != want {
			t.Errorf("ParseAccelerator(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{
		"", "cmd", "cmd+", "+", "w", "shift+w", "alt+w", "alt+shift+w", "escape", "enter", "tab", "space", "shift+tab",
		"cmd+cmd+w", "cmd+win+w", "cmd+ctrl+", "cmd+ä", "cmd+\n", "cmd+ w", "cmd+ww", "super+w",
		// text editing is never taken from the page
		"cmd+c", "cmd+v", "cmd+x", "cmd+a", "cmd+z", "cmd+shift+z", "shift+cmd+z", "CMD+C",
		"cmd+w+extra+tokens+that+make+the+string+too+long+for+the+limit",
	} {
		if got, err := ParseAccelerator(bad); err == nil {
			t.Errorf("ParseAccelerator(%q) = %q, want it refused", bad, got)
		}
	}
	// Control and cmd with the other editing keys are fine.
	for _, ok := range []string{"ctrl+c", "ctrl+z", "cmd+shift+c", "cmd+alt+v"} {
		if _, err := ParseAccelerator(ok); err != nil {
			t.Errorf("ParseAccelerator(%q) = %v", ok, err)
		}
	}
}

func TestDataStoreID(t *testing.T) {
	uuid := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	a, b := DataStoreID("0123456789abcdef"), DataStoreID("fedcba9876543210")
	if !uuid.MatchString(a) || !uuid.MatchString(b) {
		t.Fatalf("not UUIDs: %q %q", a, b)
	}
	if a == b {
		t.Fatal("two vaults share a data store")
	}
	if a != DataStoreID("0123456789abcdef") {
		t.Fatal("the identifier is not stable")
	}
}
