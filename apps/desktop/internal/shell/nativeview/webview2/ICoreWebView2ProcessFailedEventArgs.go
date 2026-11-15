// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2ProcessFailedEventArgsVtbl struct {
	IUnknownVtbl
	GetProcessFailedKind ComProc
}

type ICoreWebView2ProcessFailedEventArgs struct {
	Vtbl *ICoreWebView2ProcessFailedEventArgsVtbl
}

func (i *ICoreWebView2ProcessFailedEventArgs) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func (i *ICoreWebView2ProcessFailedEventArgs) GetProcessFailedKind() (COREWEBVIEW2_PROCESS_FAILED_KIND, error) {

	var value COREWEBVIEW2_PROCESS_FAILED_KIND

	hr, _, _ := i.Vtbl.GetProcessFailedKind.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(unsafe.Pointer(&value)),
	)
	if err := hresult(hr); err != nil {
		return 0, err
	}
	return value, nil
}
