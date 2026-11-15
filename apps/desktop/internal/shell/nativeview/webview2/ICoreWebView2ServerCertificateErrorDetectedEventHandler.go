// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2ServerCertificateErrorDetectedEventHandlerVtbl struct {
	IUnknownVtbl
	Invoke ComProc
}

type ICoreWebView2ServerCertificateErrorDetectedEventHandler struct {
	Vtbl *ICoreWebView2ServerCertificateErrorDetectedEventHandlerVtbl
	impl ICoreWebView2ServerCertificateErrorDetectedEventHandlerImpl
}

func (i *ICoreWebView2ServerCertificateErrorDetectedEventHandler) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func ICoreWebView2ServerCertificateErrorDetectedEventHandlerIUnknownQueryInterface(this *ICoreWebView2ServerCertificateErrorDetectedEventHandler, refiid, object uintptr) uintptr {
	return this.impl.QueryInterface(refiid, object)
}

func ICoreWebView2ServerCertificateErrorDetectedEventHandlerIUnknownAddRef(this *ICoreWebView2ServerCertificateErrorDetectedEventHandler) uintptr {
	return this.impl.AddRef()
}

func ICoreWebView2ServerCertificateErrorDetectedEventHandlerIUnknownRelease(this *ICoreWebView2ServerCertificateErrorDetectedEventHandler) uintptr {
	return this.impl.Release()
}

func ICoreWebView2ServerCertificateErrorDetectedEventHandlerInvoke(this *ICoreWebView2ServerCertificateErrorDetectedEventHandler, sender *ICoreWebView2, args *ICoreWebView2ServerCertificateErrorDetectedEventArgs) uintptr {
	return this.impl.ServerCertificateErrorDetected(sender, args)
}

type ICoreWebView2ServerCertificateErrorDetectedEventHandlerImpl interface {
	IUnknownImpl
	ServerCertificateErrorDetected(sender *ICoreWebView2, args *ICoreWebView2ServerCertificateErrorDetectedEventArgs) uintptr
}

var ICoreWebView2ServerCertificateErrorDetectedEventHandlerFn = ICoreWebView2ServerCertificateErrorDetectedEventHandlerVtbl{
	IUnknownVtbl{
		NewComProc(ICoreWebView2ServerCertificateErrorDetectedEventHandlerIUnknownQueryInterface),
		NewComProc(ICoreWebView2ServerCertificateErrorDetectedEventHandlerIUnknownAddRef),
		NewComProc(ICoreWebView2ServerCertificateErrorDetectedEventHandlerIUnknownRelease),
	},
	NewComProc(ICoreWebView2ServerCertificateErrorDetectedEventHandlerInvoke),
}

func NewICoreWebView2ServerCertificateErrorDetectedEventHandler(impl ICoreWebView2ServerCertificateErrorDetectedEventHandlerImpl) *ICoreWebView2ServerCertificateErrorDetectedEventHandler {
	return &ICoreWebView2ServerCertificateErrorDetectedEventHandler{
		Vtbl: &ICoreWebView2ServerCertificateErrorDetectedEventHandlerFn,
		impl: impl,
	}
}
