// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows
// +build windows

//nolint:gosec // G103: the words of a RECT that a call into COM takes by value
package webview2

import "unsafe"

// appendRectArg appends the word(s) that pass a by-value RECT argument to a
// COM method on this architecture.
//
// 386: stdcall passes the 16-byte struct as four stack words.
func appendRectArg(args []uintptr, bounds *RECT) []uintptr {
	words := (*[4]uintptr)(unsafe.Pointer(bounds))
	return append(args, words[0], words[1], words[2], words[3])
}
