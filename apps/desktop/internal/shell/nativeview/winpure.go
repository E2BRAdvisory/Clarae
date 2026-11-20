//go:build !js

package nativeview

// The part of the Windows driver (driver_windows.go) that does not touch the system: the conversion of the
// rectangle of a view to pixels, the names of keys, permissions and load errors. It builds everywhere (except
// WebAssembly) so that a machine that is not Windows can test it.

import (
	"fmt"
	"math"
	"net/url"
	"strings"

	"clarae/apps/desktop/internal/webview"
)

// pixelRect is a rectangle of the client area of a window, in physical pixels (what WebView2 wants).
type pixelRect struct{ Left, Top, Right, Bottom int32 }

// physicalRect converts a rectangle of fractions (0..1 of the client area, origin top-left) to pixels
// of a client area w by h. The edges are rounded, not the sizes, so two views that touch in fractions
// touch in pixels too; nothing is outside the client area, and a client area with no room (a window that
// is minimised reports 0 by 0) gives an empty rectangle.
func physicalRect(b webview.Bounds, w, h int32) pixelRect {
	if w <= 0 || h <= 0 {
		return pixelRect{}
	}
	edge := func(f float64, size int32) int32 {
		if math.IsNaN(f) {
			return 0
		}
		return int32(math.Round(math.Min(1, math.Max(0, f)) * float64(size)))
	}
	r := pixelRect{
		Left: edge(b.X, w), Top: edge(b.Y, h),
		Right: edge(b.X+b.Width, w), Bottom: edge(b.Y+b.Height, h),
	}
	r.Right, r.Bottom = max(r.Right, r.Left), max(r.Bottom, r.Top)
	return r
}

// ---- keys ------------------------------------------------------------------------------------

// keyName is the key of an accelerator (webview.ParseAccelerator) for a virtual-key code of Windows, or
// "". oem maps the keys that are not letters, digits or named (punctuation, which depends on the layout)
// to the character they make with no modifier (MapVirtualKey(vk, MAPVK_VK_TO_CHAR)), 0 for none.
func keyName(vk uint32, oem func(vk uint32) rune) string {
	switch {
	case vk >= 'A' && vk <= 'Z':
		return string(rune(vk - 'A' + 'a'))
	case vk >= '0' && vk <= '9':
		return string(rune(vk))
	case vk >= 0x60 && vk <= 0x69: // numeric keypad digits
		return string(rune('0' + vk - 0x60))
	case vk >= 0x70 && vk <= 0x83: // F1..F20
		return fmt.Sprintf("f%d", vk-0x70+1)
	}
	switch vk {
	case 0x08:
		return "backspace"
	case 0x09:
		return "tab"
	case 0x0D:
		return "enter"
	case 0x1B:
		return "escape"
	case 0x20:
		return "space"
	case 0x21:
		return "pageup"
	case 0x22:
		return "pagedown"
	case 0x23:
		return "end"
	case 0x24:
		return "home"
	case 0x25:
		return "left"
	case 0x26:
		return "up"
	case 0x27:
		return "right"
	case 0x28:
		return "down"
	case 0x2E:
		return "delete"
	case 0x6B: // numeric keypad +
		return "plus"
	}
	// The punctuation keys of the main block: VK_OEM_1.. VK_OEM_8 (0xBA..0xC0, 0xDB..0xDF), VK_OEM_PLUS,
	// COMMA, MINUS, PERIOD (0xBB..0xBE) and VK_OEM_102 (0xE2).
	if oem != nil && (vk >= 0xBA && vk <= 0xC0 || vk >= 0xDB && vk <= 0xDF || vk == 0xE2) {
		if r := oem(vk); r > ' ' && r < 0x7f {
			if r == '+' {
				return "plus"
			}
			return strings.ToLower(string(r))
		}
	}
	return ""
}

// accelerator writes a key with its modifiers in the form of webview.ParseAccelerator: ctrl, alt, shift,
// then the key. There is no cmd on Windows.
func accelerator(ctrl, alt, shift bool, key string) string {
	if key == "" {
		return ""
	}
	var p []string
	if ctrl {
		p = append(p, "ctrl")
	}
	if alt {
		p = append(p, "alt")
	}
	if shift {
		p = append(p, "shift")
	}
	return strings.Join(append(p, key), "+")
}

// editingKeys are the shortcuts that a text field of a page needs. The core refuses to reserve the ones
// of macOS (cmd+c...) and this driver refuses the ones of Windows itself: a guest keeps typing.
var editingKeys = map[string]bool{
	"ctrl+c": true, "ctrl+v": true, "ctrl+x": true, "ctrl+a": true, "ctrl+z": true, "ctrl+y": true,
	"ctrl+shift+z": true,
}

// reservedSet keeps, from the accelerators the core sends, the ones the keyboard of Windows can make
// and a page may be refused: nothing with cmd (the Command key of a Mac) and no editing shortcut.
func reservedSet(accelerators []string) map[string]bool {
	set := map[string]bool{}
	for _, a := range accelerators {
		a = strings.ToLower(a)
		if a == "" || editingKeys[a] || hasModifier(a, "cmd") {
			continue
		}
		set[a] = true
	}
	return set
}

func hasModifier(accel, mod string) bool {
	parts := strings.Split(accel, "+")
	for _, p := range parts[:len(parts)-1] {
		if p == mod {
			return true
		}
	}
	return false
}

// ---- what a page asks, what a load says -------------------------------------------------------

// permissionName is the name (a Permission payload of the core) for a COREWEBVIEW2_PERMISSION_KIND. The
// names are the ones of the macOS driver where WebKit has the same thing.
func permissionName(kind uint32) string {
	switch kind {
	case 1, 2:
		return "media-capture"
	case 3:
		return "geolocation"
	case 4:
		return "notifications"
	case 5:
		return "orientation"
	case 6:
		return "clipboard-read"
	case 7:
		return "automatic-downloads"
	case 8:
		return "file-access"
	case 9:
		return "autoplay"
	case 10:
		return "local-fonts"
	case 11:
		return "midi"
	case 12:
		return "window-management"
	}
	return "unknown"
}

// webErrorCancelled is COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED: a navigation that the driver
// refused, or that a newer one replaced. It is not a failure to report.
const webErrorCancelled = 14

// isCertificateStatus says whether a COREWEBVIEW2_WEB_ERROR_STATUS is a certificate that is not good.
func isCertificateStatus(status uint32) bool { return status >= 1 && status <= 5 }

// webErrorText says in words what a COREWEBVIEW2_WEB_ERROR_STATUS is. The text goes to the UI as text.
func webErrorText(status uint32) string {
	switch status {
	case 1:
		return "the name of the certificate does not match the site"
	case 2:
		return "the certificate of the site has expired"
	case 3:
		return "the client certificate contains errors"
	case 4:
		return "the certificate of the site was revoked"
	case 5:
		return "the certificate of the site is not valid"
	case 6:
		return "the server is unreachable"
	case 7:
		return "the connection timed out"
	case 8:
		return "the server answered with something that is not HTTP"
	case 9:
		return "the connection was aborted"
	case 10:
		return "the connection was reset"
	case 11:
		return "the connection was lost"
	case 12:
		return "the connection could not be made"
	case 13:
		return "the name of the host could not be resolved"
	case 15:
		return "too many redirects, or a redirect that failed"
	case 17:
		return "the site asks for credentials"
	case 18:
		return "the proxy asks for credentials"
	}
	return fmt.Sprintf("the page could not be loaded (status %d)", status)
}

// ---- addresses --------------------------------------------------------------------------------

// navigationScheme says whether a scheme may be loaded: http and https in the top frame; also about, blob
// and data in a frame inside the page (what pages build frames with). The Manager decides first; this is
// the second check, so that a mistake of one side is not the end (as in guest_darwin.m).
func navigationScheme(rawURL string, mainFrame bool) bool {
	i := strings.IndexByte(rawURL, ':')
	if i <= 0 {
		return false
	}
	switch strings.ToLower(rawURL[:i]) {
	case "http", "https":
		return true
	case "about", "blob", "data":
		return !mainFrame
	}
	return false
}

// originHost is the host of an address, without the port (what a permission names).
func originHost(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
