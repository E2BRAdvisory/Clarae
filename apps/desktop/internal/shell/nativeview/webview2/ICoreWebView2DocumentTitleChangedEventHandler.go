// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2DocumentTitleChangedEventHandlerVtbl struct {
	IUnknownVtbl
	Invoke ComProc
}

type ICoreWebView2DocumentTitleChangedEventHandler struct {
	Vtbl *ICoreWebView2DocumentTitleChangedEventHandlerVtbl
	impl ICoreWebView2DocumentTitleChangedEventHandlerImpl
}

func (i *ICoreWebView2DocumentTitleChangedEventHandler) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func ICoreWebView2DocumentTitleChangedEventHandlerIUnknownQueryInterface(this *ICoreWebView2DocumentTitleChangedEventHandler, refiid, object uintptr) uintptr {
	return this.impl.QueryInterface(refiid, object)
}

func ICoreWebView2DocumentTitleChangedEventHandlerIUnknownAddRef(this *ICoreWebView2DocumentTitleChangedEventHandler) uintptr {
	return this.impl.AddRef()
}

func ICoreWebView2DocumentTitleChangedEventHandlerIUnknownRelease(this *ICoreWebView2DocumentTitleChangedEventHandler) uintptr {
	return this.impl.Release()
}

func ICoreWebView2DocumentTitleChangedEventHandlerInvoke(this *ICoreWebView2DocumentTitleChangedEventHandler, sender *ICoreWebView2, args *IUnknown) uintptr {
	return this.impl.DocumentTitleChanged(sender, args)
}

type ICoreWebView2DocumentTitleChangedEventHandlerImpl interface {
	IUnknownImpl
	DocumentTitleChanged(sender *ICoreWebView2, args *IUnknown) uintptr
}

var ICoreWebView2DocumentTitleChangedEventHandlerFn = ICoreWebView2DocumentTitleChangedEventHandlerVtbl{
	IUnknownVtbl{
		NewComProc(ICoreWebView2DocumentTitleChangedEventHandlerIUnknownQueryInterface),
		NewComProc(ICoreWebView2DocumentTitleChangedEventHandlerIUnknownAddRef),
		NewComProc(ICoreWebView2DocumentTitleChangedEventHandlerIUnknownRelease),
	},
	NewComProc(ICoreWebView2DocumentTitleChangedEventHandlerInvoke),
}

func NewICoreWebView2DocumentTitleChangedEventHandler(impl ICoreWebView2DocumentTitleChangedEventHandlerImpl) *ICoreWebView2DocumentTitleChangedEventHandler {
	return &ICoreWebView2DocumentTitleChangedEventHandler{
		Vtbl: &ICoreWebView2DocumentTitleChangedEventHandlerFn,
		impl: impl,
	}
}
