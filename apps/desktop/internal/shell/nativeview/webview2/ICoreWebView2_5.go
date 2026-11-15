// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2_5Vtbl struct {
	ICoreWebView2_4Vtbl
	AddClientCertificateRequested    ComProc
	RemoveClientCertificateRequested ComProc
}

type ICoreWebView2_5 struct {
	Vtbl *ICoreWebView2_5Vtbl
}

func (i *ICoreWebView2_5) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func (i *ICoreWebView2) GetICoreWebView2_5() *ICoreWebView2_5 {
	var result *ICoreWebView2_5

	iidICoreWebView2_5 := NewGUID("{bedb11b8-d63c-11eb-b8bc-0242ac130003}")
	_, _, _ = i.Vtbl.QueryInterface.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(unsafe.Pointer(iidICoreWebView2_5)),
		uintptr(unsafe.Pointer(&result)))

	return result
}

func (i *ICoreWebView2_5) AddClientCertificateRequested(eventHandler *ICoreWebView2ClientCertificateRequestedEventHandler) (EventRegistrationToken, error) {

	var token EventRegistrationToken

	hr, _, _ := i.Vtbl.AddClientCertificateRequested.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(unsafe.Pointer(eventHandler)),
		uintptr(unsafe.Pointer(&token)),
	)
	if err := hresult(hr); err != nil {
		return EventRegistrationToken{}, err
	}
	return token, nil
}
