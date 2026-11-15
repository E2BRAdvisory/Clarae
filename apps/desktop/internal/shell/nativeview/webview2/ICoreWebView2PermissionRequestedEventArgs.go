// Derived from Wails v3.1.0, internal/webview2 (MIT, Copyright (c) 2018-Present Lea Anthony), which
// derives from go-webview2 (MIT, Copyright (c) 2020 John Chadwick). Reduced and corrected for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package webview2

import (
	"unsafe"
)

type ICoreWebView2PermissionRequestedEventArgsVtbl struct {
	IUnknownVtbl
	GetUri             ComProc
	GetPermissionKind  ComProc
	GetIsUserInitiated ComProc
	GetState           ComProc
	PutState           ComProc
	GetDeferral        ComProc
}

type ICoreWebView2PermissionRequestedEventArgs struct {
	Vtbl *ICoreWebView2PermissionRequestedEventArgsVtbl
}

func (i *ICoreWebView2PermissionRequestedEventArgs) AddRef() uintptr {
	refCounter, _, _ := i.Vtbl.AddRef.Call(uintptr(unsafe.Pointer(i)))
	return refCounter
}

func (i *ICoreWebView2PermissionRequestedEventArgs) GetUri() (string, error) {
	return getString(unsafe.Pointer(i), i.Vtbl.GetUri)
}

func (i *ICoreWebView2PermissionRequestedEventArgs) GetPermissionKind() (COREWEBVIEW2_PERMISSION_KIND, error) {

	var permissionKind COREWEBVIEW2_PERMISSION_KIND

	hr, _, _ := i.Vtbl.GetPermissionKind.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(unsafe.Pointer(&permissionKind)),
	)
	if err := hresult(hr); err != nil {
		return 0, err
	}
	return permissionKind, nil
}

func (i *ICoreWebView2PermissionRequestedEventArgs) GetIsUserInitiated() (bool, error) {
	// Create int32 to hold bool result
	var _isUserInitiated int32

	hr, _, _ := i.Vtbl.GetIsUserInitiated.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(unsafe.Pointer(&_isUserInitiated)),
	)
	if err := hresult(hr); err != nil {
		return false, err
	}
	// Get result and cleanup
	isUserInitiated := _isUserInitiated != 0
	return isUserInitiated, nil
}

func (i *ICoreWebView2PermissionRequestedEventArgs) PutState(state COREWEBVIEW2_PERMISSION_STATE) error {

	hr, _, _ := i.Vtbl.PutState.Call(
		uintptr(unsafe.Pointer(i)),
		uintptr(state),
	)
	if err := hresult(hr); err != nil {
		return err
	}
	return nil
}
