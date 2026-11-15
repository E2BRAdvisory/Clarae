// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2AcceleratorKeyPressedEventHandlerVtbl struct {
	IUnknownVtbl
	Invoke ComProc
}

type ICoreWebView2AcceleratorKeyPressedEventHandler struct {
	Vtbl *ICoreWebView2AcceleratorKeyPressedEventHandlerVtbl
	impl ICoreWebView2AcceleratorKeyPressedEventHandlerImpl
}

func (i *ICoreWebView2AcceleratorKeyPressedEventHandler) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func ICoreWebView2AcceleratorKeyPressedEventHandlerIUnknownQueryInterface(this *ICoreWebView2AcceleratorKeyPressedEventHandler, refiid, object uintptr) uintptr {
	return this.impl.QueryInterface(refiid, object)
}

func ICoreWebView2AcceleratorKeyPressedEventHandlerIUnknownAddRef(this *ICoreWebView2AcceleratorKeyPressedEventHandler) uintptr {
	return this.impl.AddRef()
}

func ICoreWebView2AcceleratorKeyPressedEventHandlerIUnknownRelease(this *ICoreWebView2AcceleratorKeyPressedEventHandler) uintptr {
	return this.impl.Release()
}

func ICoreWebView2AcceleratorKeyPressedEventHandlerInvoke(this *ICoreWebView2AcceleratorKeyPressedEventHandler, sender *ICoreWebView2Controller, args *ICoreWebView2AcceleratorKeyPressedEventArgs) uintptr {
	return this.impl.AcceleratorKeyPressed(sender, args)
}

type ICoreWebView2AcceleratorKeyPressedEventHandlerImpl interface {
	IUnknownImpl
	AcceleratorKeyPressed(sender *ICoreWebView2Controller, args *ICoreWebView2AcceleratorKeyPressedEventArgs) uintptr
}

var ICoreWebView2AcceleratorKeyPressedEventHandlerFn = ICoreWebView2AcceleratorKeyPressedEventHandlerVtbl{
	IUnknownVtbl{
		NewComProc(ICoreWebView2AcceleratorKeyPressedEventHandlerIUnknownQueryInterface),
		NewComProc(ICoreWebView2AcceleratorKeyPressedEventHandlerIUnknownAddRef),
		NewComProc(ICoreWebView2AcceleratorKeyPressedEventHandlerIUnknownRelease),
	},
	NewComProc(ICoreWebView2AcceleratorKeyPressedEventHandlerInvoke),
}

func NewICoreWebView2AcceleratorKeyPressedEventHandler(impl ICoreWebView2AcceleratorKeyPressedEventHandlerImpl) *ICoreWebView2AcceleratorKeyPressedEventHandler {
	return &ICoreWebView2AcceleratorKeyPressedEventHandler{
		Vtbl: &ICoreWebView2AcceleratorKeyPressedEventHandlerFn,
		impl: impl,
	}
}
