// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2BasicAuthenticationRequestedEventArgsVtbl struct {
	IUnknownVtbl
	GetUri       ComProc
	GetChallenge ComProc
	GetResponse  ComProc
	GetCancel    ComProc
	PutCancel    ComProc
	GetDeferral  ComProc
}

type ICoreWebView2BasicAuthenticationRequestedEventArgs struct {
	Vtbl *ICoreWebView2BasicAuthenticationRequestedEventArgsVtbl
}

func (i *ICoreWebView2BasicAuthenticationRequestedEventArgs) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func (i *ICoreWebView2BasicAuthenticationRequestedEventArgs) GetUri() (string, error) {
	return getString(unsafe.Pointer(i), i.Vtbl.GetUri)
}

func (i *ICoreWebView2BasicAuthenticationRequestedEventArgs) PutCancel(cancel bool) error {

	// BOOL is a 4-byte by-value parameter: pass the value, not a pointer
	// to a 1-byte Go bool.
	var _cancelInt int32
	if cancel {
		_cancelInt = 1
	}
	hr, _, _ := i.Vtbl.PutCancel.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(_cancelInt),
	)
	if err := hresult(hr); err != nil {
		return err
	}
	return nil
}
