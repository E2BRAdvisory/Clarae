// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl struct {
	IUnknownVtbl
	Invoke ComProc
}

type ICoreWebView2CreateCoreWebView2ControllerCompletedHandler struct {
	Vtbl *ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl
	impl ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerImpl
}

func (i *ICoreWebView2CreateCoreWebView2ControllerCompletedHandler) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerIUnknownQueryInterface(this *ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, refiid, object uintptr) uintptr {
	return this.impl.QueryInterface(refiid, object)
}

func ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerIUnknownAddRef(this *ICoreWebView2CreateCoreWebView2ControllerCompletedHandler) uintptr {
	return this.impl.AddRef()
}

func ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerIUnknownRelease(this *ICoreWebView2CreateCoreWebView2ControllerCompletedHandler) uintptr {
	return this.impl.Release()
}

func ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerInvoke(this *ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, errorCode uintptr, result *ICoreWebView2Controller) uintptr {
	return this.impl.CreateCoreWebView2ControllerCompleted(errorCode, result)
}

type ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerImpl interface {
	IUnknownImpl
	CreateCoreWebView2ControllerCompleted(errorCode uintptr, result *ICoreWebView2Controller) uintptr
}

var ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerFn = ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl{
	IUnknownVtbl{
		NewComProc(ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerIUnknownQueryInterface),
		NewComProc(ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerIUnknownAddRef),
		NewComProc(ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerIUnknownRelease),
	},
	NewComProc(ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerInvoke),
}

func NewICoreWebView2CreateCoreWebView2ControllerCompletedHandler(impl ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerImpl) *ICoreWebView2CreateCoreWebView2ControllerCompletedHandler {
	return &ICoreWebView2CreateCoreWebView2ControllerCompletedHandler{
		Vtbl: &ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerFn,
		impl: impl,
	}
}
