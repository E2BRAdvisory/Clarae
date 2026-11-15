// Derived from Wails v3.1.0, internal/webview2/webviewloader (ISC, Copyright (c) 2020 John Chadwick,
// Copyright (c) 2022 Wails Project Developers), a port of OpenWebView2Loader. Reduced for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package loader

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modole32           = windows.NewLazySystemDLL("ole32.dll")
	procCoTaskMemAlloc = modole32.NewProc("CoTaskMemAlloc")
)

func coTaskMemAlloc(size int) unsafe.Pointer {
	ret, _, _ := procCoTaskMemAlloc.Call(uintptr(size))
	if ret == 0 {
		panic("coTaskMemAlloc failed")
	}
	return *(*unsafe.Pointer)(unsafe.Pointer(&ret)) // memory that is not Go's
}
