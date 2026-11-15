// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

package combridge

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type IUnknownVtbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
}

func (i *IUnknownVtbl) QueryInterface(this unsafe.Pointer, refiid *windows.GUID, ppvObject **IUnknownImpl) error {
	r, _, _ := syscall.SyscallN(
		i.queryInterface,
		uintptr(this),
		uintptr(unsafe.Pointer(refiid)),    //nolint:gosec // arguments of a call into COM
		uintptr(unsafe.Pointer(ppvObject)), //nolint:gosec // arguments of a call into COM
	)

	if r != uintptr(windows.S_OK) {
		return syscall.Errno(r)
	}

	return nil
}

func (i *IUnknownVtbl) AddRef(this unsafe.Pointer) uint32 {
	r, _, _ := syscall.SyscallN(
		i.addRef,
		uintptr(this),
	)
	return uint32(r) //nolint:gosec // a count that is never negative
}

func (i *IUnknownVtbl) Release(this unsafe.Pointer) uint32 {
	r, _, _ := syscall.SyscallN(
		i.release,
		uintptr(this),
	)

	return uint32(r) //nolint:gosec // a count that is never negative
}

type IUnknownImpl struct {
	vtbl *IUnknownVtbl
}

func (i *IUnknownImpl) QueryInterface(refiid *windows.GUID, ppvObject **IUnknownImpl) error {
	return i.vtbl.QueryInterface(unsafe.Pointer(i), refiid, ppvObject) //nolint:gosec // the COM object is the pointer
}

func (i *IUnknownImpl) AddRef() uint32 {
	return i.vtbl.AddRef(unsafe.Pointer(i)) //nolint:gosec // the COM object is the pointer
}

func (i *IUnknownImpl) Release() uint32 {
	return i.vtbl.Release(unsafe.Pointer(i)) //nolint:gosec // the COM object is the pointer
}
