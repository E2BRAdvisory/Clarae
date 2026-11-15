// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2ClientCertificateRequestedEventArgsVtbl struct {
	IUnknownVtbl
	GetHost                          ComProc
	GetPort                          ComProc
	GetIsProxy                       ComProc
	GetAllowedCertificateAuthorities ComProc
	GetMutuallyTrustedCertificates   ComProc
	GetSelectedCertificate           ComProc
	PutSelectedCertificate           ComProc
	GetCancel                        ComProc
	PutCancel                        ComProc
	GetHandled                       ComProc
	PutHandled                       ComProc
	GetDeferral                      ComProc
}

type ICoreWebView2ClientCertificateRequestedEventArgs struct {
	Vtbl *ICoreWebView2ClientCertificateRequestedEventArgsVtbl
}

func (i *ICoreWebView2ClientCertificateRequestedEventArgs) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func (i *ICoreWebView2ClientCertificateRequestedEventArgs) GetHost() (string, error) {
	return getString(unsafe.Pointer(i), i.Vtbl.GetHost)
}

func (i *ICoreWebView2ClientCertificateRequestedEventArgs) PutCancel(value bool) error {

	// BOOL is a 4-byte by-value parameter: pass the value, not a pointer
	// to a 1-byte Go bool.
	var _valueInt int32
	if value {
		_valueInt = 1
	}
	hr, _, _ := i.Vtbl.PutCancel.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(_valueInt),
	)
	if err := hresult(hr); err != nil {
		return err
	}
	return nil
}

func (i *ICoreWebView2ClientCertificateRequestedEventArgs) PutHandled(value bool) error {

	// BOOL is a 4-byte by-value parameter: pass the value, not a pointer
	// to a 1-byte Go bool.
	var _valueInt int32
	if value {
		_valueInt = 1
	}
	hr, _, _ := i.Vtbl.PutHandled.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(_valueInt),
	)
	if err := hresult(hr); err != nil {
		return err
	}
	return nil
}
