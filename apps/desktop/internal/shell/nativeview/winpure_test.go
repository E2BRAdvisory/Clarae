//go:build !js

package nativeview

import (
	"errors"
	"path/filepath"
	"runtime"
	"testing"

	"clarae/apps/desktop/internal/webview"
)

func TestPhysicalRect(t *testing.T) {
	tests := []struct {
		name string
		b    webview.Bounds
		w, h int32
		want pixelRect
	}{
		{"all of it", webview.Bounds{X: 0, Y: 0, Width: 1, Height: 1}, 1920, 1080, pixelRect{0, 0, 1920, 1080}},
		{"a pane", webview.Bounds{X: 0.25, Y: 0.1, Width: 0.5, Height: 0.8}, 1000, 500, pixelRect{250, 50, 750, 450}},
		// 150 % display: the client area is in physical pixels, the fractions do not change.
		{"150 percent", webview.Bounds{X: 0.2, Y: 0.2, Width: 0.6, Height: 0.6}, 2880, 1620, pixelRect{576, 324, 2304, 1296}},
		// The edges are rounded, not the sizes: a rectangle that starts where the other ends has the same pixel.
		{"rounded edges", webview.Bounds{X: 1.0 / 3, Y: 0, Width: 1.0 / 3, Height: 1}, 100, 10, pixelRect{33, 0, 67, 10}},
		{"outside is cut", webview.Bounds{X: 0.5, Y: -0.5, Width: 2, Height: 3}, 100, 100, pixelRect{50, 0, 100, 100}},
		{"minimised", webview.Bounds{X: 0, Y: 0, Width: 1, Height: 1}, 0, 0, pixelRect{}},
		{"negative client", webview.Bounds{X: 0, Y: 0, Width: 1, Height: 1}, -5, 10, pixelRect{}},
		{"empty", webview.Bounds{X: 0.5, Y: 0.5}, 800, 600, pixelRect{400, 300, 400, 300}},
	}
	for _, tt := range tests {
		if got := physicalRect(tt.b, tt.w, tt.h); got != tt.want {
			t.Errorf("%s: physicalRect(%+v, %d, %d) = %+v, want %+v", tt.name, tt.b, tt.w, tt.h, got, tt.want)
		}
	}
	// The neighbours of a split touch.
	left := physicalRect(webview.Bounds{X: 0, Y: 0, Width: 0.37, Height: 1}, 1001, 700)
	right := physicalRect(webview.Bounds{X: 0.37, Y: 0, Width: 0.63, Height: 1}, 1001, 700)
	if left.Right != right.Left || right.Right != 1001 {
		t.Errorf("a split leaves a gap or an overlap: %+v %+v", left, right)
	}
}

func TestWebappsRoot(t *testing.T) {
	if got := webappsRoot(""); got != "" {
		t.Errorf("no path given to Wails: %q, want none (its default folder is not ours)", got)
	}
	if got := webappsRoot("relative/webview"); got != "" {
		t.Errorf("relative path: %q, want none", got)
	}
	base := filepath.Join(t.TempDir(), "Clarae")
	if got, want := webappsRoot(filepath.Join(base, "webview")), filepath.Join(base, "webapps"); got != want {
		t.Errorf("webappsRoot = %q, want %q", got, want)
	}
	if got, want := webappsRoot(filepath.Join(base, "webview")+string(filepath.Separator)), filepath.Join(base, "webapps"); got != want {
		t.Errorf("trailing separator: %q, want %q", got, want)
	}
}

func TestUserDataFolder(t *testing.T) {
	root := filepath.Join(t.TempDir(), "webapps")
	a, err := userDataFolder(root, "2F1E0C34-0000-4000-8000-ABCDEF012345")
	if err != nil {
		t.Fatal(err)
	}
	b, err := userDataFolder(root, "2f1e0c34-0000-4000-8000-abcdef012345")
	if err != nil || a != b {
		t.Errorf("two spellings of a store are two folders: %q %q (%v)", a, b, err)
	}
	if filepath.Dir(a) != root {
		t.Errorf("the folder of a store is not directly in the root: %q", a)
	}
	c, err := userDataFolder(root, webview.DataStoreID("vault-1"))
	if err != nil || filepath.Dir(c) != root {
		t.Errorf("DataStoreID is not a valid store: %q, %v", c, err)
	}
	if d, _ := userDataFolder(root, webview.DataStoreID("vault-2")); d == c {
		t.Error("two vaults share a folder")
	}
	for _, bad := range []string{"", ".", "..", "../x", `..\x`, "a/b", `a\b`, "a b", "-x", "a:b", "a.b", "é", string(make([]byte, 65)), "C:", "x\x00y"} {
		if f, err := userDataFolder(root, bad); err == nil {
			t.Errorf("userDataFolder(%q) = %q, want an error", bad, f)
		}
	}
	if _, err := userDataFolder("", "abc"); !errors.Is(err, errNoDataFolder) {
		t.Errorf("no root: %v, want errNoDataFolder", err)
	}
	if runtime.GOOS == "windows" {
		if f, err := userDataFolder(`C:\data\webapps`, "abc"); err != nil || f != `C:\data\webapps\abc` {
			t.Errorf("windows path: %q, %v", f, err)
		}
	}
}

func TestKeyNames(t *testing.T) {
	oem := func(vk uint32) rune {
		return map[uint32]rune{0xBB: '=', 0xBC: ',', 0xBD: '-', 0xBE: '.', 0xDB: '[', 0xDD: ']', 0xC0: '`', 0xBA: ';', 0xE2: '<'}[vk]
	}
	tests := []struct {
		vk   uint32
		want string
	}{
		{'W', "w"}, {'A', "a"}, {'Z', "z"}, {'0', "0"}, {'9', "9"}, {0x60, "0"}, {0x69, "9"},
		{0x70, "f1"}, {0x7B, "f12"}, {0x83, "f20"}, {0x84, ""},
		{0x08, "backspace"}, {0x09, "tab"}, {0x0D, "enter"}, {0x1B, "escape"}, {0x20, "space"},
		{0x21, "pageup"}, {0x22, "pagedown"}, {0x23, "end"}, {0x24, "home"},
		{0x25, "left"}, {0x26, "up"}, {0x27, "right"}, {0x28, "down"}, {0x2E, "delete"}, {0x6B, "plus"},
		{0xBB, "="}, {0xBD, "-"}, {0xDB, "["}, {0xC0, "`"}, {0xE2, "<"},
		{0xBF, ""}, // the layout makes no character for it
		{0x10, ""}, {0x11, ""}, {0x12, ""}, {0x5B, ""}, {0x00, ""},
	}
	for _, tt := range tests {
		if got := keyName(tt.vk, oem); got != tt.want {
			t.Errorf("keyName(%#x) = %q, want %q", tt.vk, got, tt.want)
		}
	}
	if got := keyName(0xBB, nil); got != "" {
		t.Errorf("no layout function: %q", got)
	}
	plus := func(uint32) rune { return '+' }
	if got := keyName(0xBB, plus); got != "plus" {
		t.Errorf("the plus sign is spelled %q, want plus", got)
	}
	control := func(uint32) rune { return 0x08 }
	if got := keyName(0xBB, control); got != "" {
		t.Errorf("a control character is a key name: %q", got)
	}
}

func TestAcceleratorForm(t *testing.T) {
	tests := []struct {
		ctrl, alt, shift bool
		key, want        string
	}{
		{true, false, false, "w", "ctrl+w"},
		{true, false, true, "tab", "ctrl+shift+tab"},
		{true, true, true, "left", "ctrl+alt+shift+left"},
		{false, false, false, "f5", "f5"},
		{true, false, false, "", ""},
	}
	for _, tt := range tests {
		got := accelerator(tt.ctrl, tt.alt, tt.shift, tt.key)
		if got != tt.want {
			t.Errorf("accelerator(%v,%v,%v,%q) = %q, want %q", tt.ctrl, tt.alt, tt.shift, tt.key, got, tt.want)
		}
		// What the driver writes is what the core accepts and writes back.
		if got != "" {
			if canon, err := webview.ParseAccelerator(got); err != nil || canon != got {
				t.Errorf("%q is not canonical for the core: %q, %v", got, canon, err)
			}
		}
	}
}

func TestReservedSet(t *testing.T) {
	set := reservedSet([]string{"ctrl+w", "CTRL+Shift+Tab", "cmd+w", "shift+cmd+p", "ctrl+c", "ctrl+v", "ctrl+x", "ctrl+a", "ctrl+z", "ctrl+y", "ctrl+shift+z", "f5", "", "ctrl+alt+left"})
	for _, ok := range []string{"ctrl+w", "ctrl+shift+tab", "f5", "ctrl+alt+left"} {
		if !set[ok] {
			t.Errorf("%q was not kept", ok)
		}
	}
	for _, no := range []string{"cmd+w", "shift+cmd+p", "ctrl+c", "ctrl+v", "ctrl+x", "ctrl+a", "ctrl+z", "ctrl+y", "ctrl+shift+z", ""} {
		if set[no] {
			t.Errorf("%q must not be reserved on Windows", no)
		}
	}
	if len(reservedSet(nil)) != 0 {
		t.Error("an empty list reserves something")
	}
}

func TestPermissionNames(t *testing.T) {
	for kind, want := range map[uint32]string{
		0: "unknown", 1: "media-capture", 2: "media-capture", 3: "geolocation", 4: "notifications", 5: "orientation",
		6: "clipboard-read", 7: "automatic-downloads", 8: "file-access", 9: "autoplay", 10: "local-fonts",
		11: "midi", 12: "window-management", 13: "unknown", 1 << 31: "unknown",
	} {
		if got := permissionName(kind); got != want {
			t.Errorf("permissionName(%d) = %q, want %q", kind, got, want)
		}
	}
}

func TestWebErrors(t *testing.T) {
	for s := uint32(0); s <= 40; s++ {
		cert := s >= 1 && s <= 5
		if isCertificateStatus(s) != cert {
			t.Errorf("isCertificateStatus(%d) = %v", s, !cert)
		}
		if webErrorText(s) == "" {
			t.Errorf("no text for status %d", s)
		}
	}
	if webErrorCancelled != 14 {
		t.Errorf("OPERATION_CANCELED is 14 in WebView2.idl, not %d", webErrorCancelled)
	}
}

func TestNavigationScheme(t *testing.T) {
	tests := []struct {
		url   string
		main  bool
		frame bool
	}{
		{"https://example.com/", true, true},
		{"HTTP://example.com/", true, true},
		{"http://localhost:8080", true, true},
		{"about:blank", false, true},
		{"about:srcdoc", false, true},
		{"blob:https://example.com/1", false, true},
		{"data:text/html,x", false, true},
		{"javascript:alert(1)", false, false},
		{"file:///C:/Windows/win.ini", false, false},
		{"ftp://example.com/", false, false},
		{"ms-settings:", false, false},
		{"chrome://settings", false, false},
		{"edge://settings", false, false},
		{"wails://wails/", false, false},
		{"view-source:https://example.com", false, false},
		{"", false, false},
		{":", false, false},
		{"//example.com", false, false},
	}
	for _, tt := range tests {
		if got := navigationScheme(tt.url, true); got != tt.main {
			t.Errorf("navigationScheme(%q, main) = %v, want %v", tt.url, got, tt.main)
		}
		if got := navigationScheme(tt.url, false); got != tt.frame {
			t.Errorf("navigationScheme(%q, frame) = %v, want %v", tt.url, got, tt.frame)
		}
	}
}

func TestOriginHost(t *testing.T) {
	for in, want := range map[string]string{
		"https://example.com/a?b=c": "example.com", "https://example.com:8443/": "example.com",
		"http://[::1]:3000/": "::1", "": "", "%zz": "", "https://user@host.example/": "host.example",
	} {
		if got := originHost(in); got != want {
			t.Errorf("originHost(%q) = %q, want %q", in, got, want)
		}
	}
}
