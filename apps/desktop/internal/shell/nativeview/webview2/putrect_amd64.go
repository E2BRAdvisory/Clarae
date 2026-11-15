// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows
// +build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import "unsafe"

// appendRectArg appends the word(s) that pass a by-value RECT argument to a
// COM method on this architecture.
//
// amd64: structs larger than 8 bytes are passed by reference.
func appendRectArg(args []uintptr, bounds *RECT) []uintptr {
	return append(args, uintptr(unsafe.Pointer(bounds)))
}
