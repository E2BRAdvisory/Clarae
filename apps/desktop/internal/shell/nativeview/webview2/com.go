// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

// Package webview2 is the part of the COM binding of WebView2 that the driver of the native web views
// needs (internal/shell/nativeview): the vtables of the interfaces it calls, in the order of WebView2.idl,
// and a method for each call it makes.
//
// It is a reduction of the binding that Wails v3.1.0 keeps in its internal package (internal/webview2/pkg/
// webview2, itself from go-webview2 of John Chadwick), see NOTICE in this folder. Wails does not export
// it, and the application may not patch Wails. What was left out: every interface, event and method that
// the driver does not call. What was changed, because the original is wrong for what the driver does
// (ADR-0056, and the tests of Windows in docs/qa):
//
//   - a method that returns a string through an out parameter (get_Source, get_Uri...) passed a null
//     pointer where the address of the pointer is due: getString does it right;
//   - get_ICoreWebView2Settings3..6 asked the web view for the interface of its settings: they ask the
//     settings;
//   - put_Bounds passed the rectangle by address on every architecture: on arm64 a 16-byte structure
//     travels in two registers (appendRectArg);
//   - an HRESULT is 32 bits: the upper half of the register that carries it is not looked at.
//
//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ComProc stores a COM procedure.
type ComProc uintptr

// NewComProc creates a new COM proc from a Go function.
func NewComProc(fn interface{}) ComProc {
	return ComProc(windows.NewCallback(fn))
}

// Call calls a COM procedure.
//
//go:uintptrescapes
func (p ComProc) Call(a ...uintptr) (r1, r2 uintptr, lastErr error) {
	return syscall.SyscallN(uintptr(p), a...)
}

// Error is a failed HRESULT.
type Error uint32

func (e Error) Error() string { return fmt.Sprintf("HRESULT 0x%08x", uint32(e)) }

// hresult turns the value a COM method returned into an error: nil for S_OK and every other success code.
func hresult(hr uintptr) error {
	if Failed(hr) {
		return Error(hr) //nolint:gosec // the low 32 bits are the HRESULT
	}
	return nil
}

// Failed says whether the value a COM method returned is a failed HRESULT (negative, as 32 bits).
func Failed(hr uintptr) bool {
	return int32(hr) < 0 //nolint:gosec // the low 32 bits are the HRESULT
}

// getString calls a method that gives a string through an LPWSTR out parameter, which the caller frees.
func getString(this unsafe.Pointer, proc ComProc) (string, error) {
	var p *uint16
	hr, _, _ := proc.Call(uintptr(this), uintptr(unsafe.Pointer(&p)))
	if err := hresult(hr); err != nil {
		return "", err
	}
	s := windows.UTF16PtrToString(p)
	windows.CoTaskMemFree(unsafe.Pointer(p))
	return s, nil
}

type EventRegistrationToken struct {
	value int64
}

// IUnknown
type IUnknown struct {
	Vtbl *IUnknownVtbl
}

type IUnknownVtbl struct {
	QueryInterface ComProc
	AddRef         ComProc
	Release        ComProc
}

// Release drops one reference of a COM interface pointer.
func Release(p unsafe.Pointer) {
	if p != nil {
		(*IUnknown)(p).Vtbl.CallRelease(p)
	}
}

func (i *IUnknownVtbl) CallRelease(this unsafe.Pointer) uint32 {
	ret, _, _ := i.Release.Call(uintptr(this))
	return uint32(ret) //nolint:gosec // the count is 32 bits
}

type IUnknownImpl interface {
	QueryInterface(refiid, object uintptr) uintptr
	AddRef() uintptr
	Release() uintptr
}

type RECT struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

type HWND uintptr

func UTF16PtrFromString(s string) (*uint16, error) {
	return windows.UTF16PtrFromString(s)
}

// GUID is the GUID of Windows.
type GUID = windows.GUID

// NewGUID parses "{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}"; nil if it is not one.
func NewGUID(guid string) *GUID {
	g, err := windows.GUIDFromString(guid)
	if err != nil {
		return nil
	}
	return &g
}

// IsEqualGUID compares two GUIDs.
func IsEqualGUID(a, b *GUID) bool { return *a == *b }
