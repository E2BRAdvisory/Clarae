// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package combridge

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modkernel32     = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalAlloc = modkernel32.NewProc("GlobalAlloc")
	procGlobalFree  = modkernel32.NewProc("GlobalFree")

	uintptrSize = unsafe.Sizeof(uintptr(0))
)

func allocUintptrObject(size int) (uintptr, []uintptr) {
	v := globalAlloc(uintptr(size) * uintptrSize)
	slice := unsafe.Slice((*uintptr)(pointerOf(v)), size) //nolint:gosec // memory of GlobalAlloc, which Go does not move
	return v, slice
}

func globalAlloc(dwBytes uintptr) uintptr {
	ret, _, _ := procGlobalAlloc.Call(uintptr(0), dwBytes)
	if ret == 0 {
		panic("globalAlloc failed")
	}

	return ret
}

func globalFree(data uintptr) {
	ret, _, _ := procGlobalFree.Call(data)
	if ret != 0 {
		panic("globalFree failed")
	}
}

// pointerOf turns the address of memory that is not Go's (GlobalAlloc) into a pointer.
func pointerOf(u uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&u)) }
