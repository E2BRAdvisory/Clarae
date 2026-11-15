// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2NavigationStartingEventHandlerVtbl struct {
	IUnknownVtbl
	Invoke ComProc
}

type ICoreWebView2NavigationStartingEventHandler struct {
	Vtbl *ICoreWebView2NavigationStartingEventHandlerVtbl
	impl ICoreWebView2NavigationStartingEventHandlerImpl
}

func (i *ICoreWebView2NavigationStartingEventHandler) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func ICoreWebView2NavigationStartingEventHandlerIUnknownQueryInterface(this *ICoreWebView2NavigationStartingEventHandler, refiid, object uintptr) uintptr {
	return this.impl.QueryInterface(refiid, object)
}

func ICoreWebView2NavigationStartingEventHandlerIUnknownAddRef(this *ICoreWebView2NavigationStartingEventHandler) uintptr {
	return this.impl.AddRef()
}

func ICoreWebView2NavigationStartingEventHandlerIUnknownRelease(this *ICoreWebView2NavigationStartingEventHandler) uintptr {
	return this.impl.Release()
}

func ICoreWebView2NavigationStartingEventHandlerInvoke(this *ICoreWebView2NavigationStartingEventHandler, sender *ICoreWebView2, args *ICoreWebView2NavigationStartingEventArgs) uintptr {
	return this.impl.NavigationStarting(sender, args)
}

type ICoreWebView2NavigationStartingEventHandlerImpl interface {
	IUnknownImpl
	NavigationStarting(sender *ICoreWebView2, args *ICoreWebView2NavigationStartingEventArgs) uintptr
}

var ICoreWebView2NavigationStartingEventHandlerFn = ICoreWebView2NavigationStartingEventHandlerVtbl{
	IUnknownVtbl{
		NewComProc(ICoreWebView2NavigationStartingEventHandlerIUnknownQueryInterface),
		NewComProc(ICoreWebView2NavigationStartingEventHandlerIUnknownAddRef),
		NewComProc(ICoreWebView2NavigationStartingEventHandlerIUnknownRelease),
	},
	NewComProc(ICoreWebView2NavigationStartingEventHandlerInvoke),
}

func NewICoreWebView2NavigationStartingEventHandler(impl ICoreWebView2NavigationStartingEventHandlerImpl) *ICoreWebView2NavigationStartingEventHandler {
	return &ICoreWebView2NavigationStartingEventHandler{
		Vtbl: &ICoreWebView2NavigationStartingEventHandlerFn,
		impl: impl,
	}
}
