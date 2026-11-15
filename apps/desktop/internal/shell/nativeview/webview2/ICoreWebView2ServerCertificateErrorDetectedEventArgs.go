// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2ServerCertificateErrorDetectedEventArgsVtbl struct {
	IUnknownVtbl
	GetErrorStatus       ComProc
	GetRequestUri        ComProc
	GetServerCertificate ComProc
	GetAction            ComProc
	PutAction            ComProc
	GetDeferral          ComProc
}

type ICoreWebView2ServerCertificateErrorDetectedEventArgs struct {
	Vtbl *ICoreWebView2ServerCertificateErrorDetectedEventArgsVtbl
}

func (i *ICoreWebView2ServerCertificateErrorDetectedEventArgs) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func (i *ICoreWebView2ServerCertificateErrorDetectedEventArgs) GetRequestUri() (string, error) {
	return getString(unsafe.Pointer(i), i.Vtbl.GetRequestUri)
}

func (i *ICoreWebView2ServerCertificateErrorDetectedEventArgs) PutAction(value COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION) error {

	hr, _, _ := i.Vtbl.PutAction.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(value),
	)
	if err := hresult(hr); err != nil {
		return err
	}
	return nil
}
