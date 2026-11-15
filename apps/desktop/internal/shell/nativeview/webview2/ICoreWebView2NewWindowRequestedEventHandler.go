// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2NewWindowRequestedEventHandlerVtbl struct {
	IUnknownVtbl
	Invoke ComProc
}

type ICoreWebView2NewWindowRequestedEventHandler struct {
	Vtbl *ICoreWebView2NewWindowRequestedEventHandlerVtbl
	impl ICoreWebView2NewWindowRequestedEventHandlerImpl
}

func (i *ICoreWebView2NewWindowRequestedEventHandler) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func ICoreWebView2NewWindowRequestedEventHandlerIUnknownQueryInterface(this *ICoreWebView2NewWindowRequestedEventHandler, refiid, object uintptr) uintptr {
	return this.impl.QueryInterface(refiid, object)
}

func ICoreWebView2NewWindowRequestedEventHandlerIUnknownAddRef(this *ICoreWebView2NewWindowRequestedEventHandler) uintptr {
	return this.impl.AddRef()
}

func ICoreWebView2NewWindowRequestedEventHandlerIUnknownRelease(this *ICoreWebView2NewWindowRequestedEventHandler) uintptr {
	return this.impl.Release()
}

func ICoreWebView2NewWindowRequestedEventHandlerInvoke(this *ICoreWebView2NewWindowRequestedEventHandler, sender *ICoreWebView2, args *ICoreWebView2NewWindowRequestedEventArgs) uintptr {
	return this.impl.NewWindowRequested(sender, args)
}

type ICoreWebView2NewWindowRequestedEventHandlerImpl interface {
	IUnknownImpl
	NewWindowRequested(sender *ICoreWebView2, args *ICoreWebView2NewWindowRequestedEventArgs) uintptr
}

var ICoreWebView2NewWindowRequestedEventHandlerFn = ICoreWebView2NewWindowRequestedEventHandlerVtbl{
	IUnknownVtbl{
		NewComProc(ICoreWebView2NewWindowRequestedEventHandlerIUnknownQueryInterface),
		NewComProc(ICoreWebView2NewWindowRequestedEventHandlerIUnknownAddRef),
		NewComProc(ICoreWebView2NewWindowRequestedEventHandlerIUnknownRelease),
	},
	NewComProc(ICoreWebView2NewWindowRequestedEventHandlerInvoke),
}

func NewICoreWebView2NewWindowRequestedEventHandler(impl ICoreWebView2NewWindowRequestedEventHandlerImpl) *ICoreWebView2NewWindowRequestedEventHandler {
	return &ICoreWebView2NewWindowRequestedEventHandler{
		Vtbl: &ICoreWebView2NewWindowRequestedEventHandlerFn,
		impl: impl,
	}
}
