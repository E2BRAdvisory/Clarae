// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2HistoryChangedEventHandlerVtbl struct {
	IUnknownVtbl
	Invoke ComProc
}

type ICoreWebView2HistoryChangedEventHandler struct {
	Vtbl *ICoreWebView2HistoryChangedEventHandlerVtbl
	impl ICoreWebView2HistoryChangedEventHandlerImpl
}

func (i *ICoreWebView2HistoryChangedEventHandler) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func ICoreWebView2HistoryChangedEventHandlerIUnknownQueryInterface(this *ICoreWebView2HistoryChangedEventHandler, refiid, object uintptr) uintptr {
	return this.impl.QueryInterface(refiid, object)
}

func ICoreWebView2HistoryChangedEventHandlerIUnknownAddRef(this *ICoreWebView2HistoryChangedEventHandler) uintptr {
	return this.impl.AddRef()
}

func ICoreWebView2HistoryChangedEventHandlerIUnknownRelease(this *ICoreWebView2HistoryChangedEventHandler) uintptr {
	return this.impl.Release()
}

func ICoreWebView2HistoryChangedEventHandlerInvoke(this *ICoreWebView2HistoryChangedEventHandler, sender *ICoreWebView2, args *IUnknown) uintptr {
	return this.impl.HistoryChanged(sender, args)
}

type ICoreWebView2HistoryChangedEventHandlerImpl interface {
	IUnknownImpl
	HistoryChanged(sender *ICoreWebView2, args *IUnknown) uintptr
}

var ICoreWebView2HistoryChangedEventHandlerFn = ICoreWebView2HistoryChangedEventHandlerVtbl{
	IUnknownVtbl{
		NewComProc(ICoreWebView2HistoryChangedEventHandlerIUnknownQueryInterface),
		NewComProc(ICoreWebView2HistoryChangedEventHandlerIUnknownAddRef),
		NewComProc(ICoreWebView2HistoryChangedEventHandlerIUnknownRelease),
	},
	NewComProc(ICoreWebView2HistoryChangedEventHandlerInvoke),
}

func NewICoreWebView2HistoryChangedEventHandler(impl ICoreWebView2HistoryChangedEventHandlerImpl) *ICoreWebView2HistoryChangedEventHandler {
	return &ICoreWebView2HistoryChangedEventHandler{
		Vtbl: &ICoreWebView2HistoryChangedEventHandlerFn,
		impl: impl,
	}
}
