// Derived from Wails v3.1.0, internal/webview2/webviewloader (ISC, Copyright (c) 2020 John Chadwick,
// Copyright (c) 2022 Wails Project Developers), a port of OpenWebView2Loader. Reduced for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package loader

import (
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"clarae/apps/desktop/internal/shell/nativeview/webview2/combridge"
)

// environmentOptions are the options of the environment, as the COM objects ICoreWebView2EnvironmentOptions
// and ICoreWebView2EnvironmentOptions2 that the library asks for. Only the user data folder is a choice;
// the rest answers with the default of each (no browser arguments, the language of the system, the
// oldest runtime that is compatible, no single sign-on with the account of Windows, no exclusive access).
type environmentOptions struct {
	userDataFolder string
}

var _ iCoreWebView2EnvironmentOptions = &environmentOptions{}
var _ iCoreWebView2EnvironmentOptions2 = &environmentOptions{}

func (o *environmentOptions) AdditionalBrowserArguments() string { return "" }
func (o *environmentOptions) Language() string                   { return "" }
func (o *environmentOptions) TargetCompatibleBrowserVersion() string {
	return kMinimumCompatibleVersion
}
func (o *environmentOptions) AllowSingleSignOnUsingOSPrimaryAccount() bool { return false }
func (o *environmentOptions) ExclusiveUserDataFolderAccess() bool          { return false }

type iCoreWebView2EnvironmentOptions interface {
	combridge.IUnknown

	AdditionalBrowserArguments() string
	Language() string
	TargetCompatibleBrowserVersion() string
	AllowSingleSignOnUsingOSPrimaryAccount() bool
}

type iCoreWebView2EnvironmentOptions2 interface {
	combridge.IUnknown

	ExclusiveUserDataFolderAccess() bool
}

func init() {
	combridge.RegisterVTable[combridge.IUnknown, iCoreWebView2EnvironmentOptions](
		"{2fde08a8-1e9a-4766-8c05-95a9ceb9d1c5}",
		_iCoreWebView2EnvironmentOptionsAdditionalBrowserArguments,
		_iCoreWebView2EnvironmentOptionsNOP,
		_iCoreWebView2EnvironmentOptionsLanguage,
		_iCoreWebView2EnvironmentOptionsNOP,
		_iCoreWebView2EnvironmentTargetCompatibleBrowserVersion,
		_iCoreWebView2EnvironmentOptionsNOP,
		_iCoreWebView2EnvironmentOptionsAllowSingleSignOnUsingOSPrimaryAccount,
		_iCoreWebView2EnvironmentOptionsNOP,
	)

	combridge.RegisterVTable[combridge.IUnknown, iCoreWebView2EnvironmentOptions2](
		"{ff85c98a-1ba7-4a6b-90c8-2b752c89e9e2}",
		_iCoreWebView2EnvironmentOptions2ExclusiveUserDataFolderAccess,
		_iCoreWebView2EnvironmentOptionsNOP,
	)
}

// The setters of the options are not called by the library: they answer S_FALSE.
func _iCoreWebView2EnvironmentOptionsNOP(this uintptr) uintptr {
	return uintptr(windows.S_FALSE)
}

func _iCoreWebView2EnvironmentOptionsAdditionalBrowserArguments(this uintptr, value **uint16) uintptr {
	v := combridge.Resolve[iCoreWebView2EnvironmentOptions](this).AdditionalBrowserArguments()
	*value = stringToOleString(v)
	return uintptr(windows.S_OK)
}

func _iCoreWebView2EnvironmentOptionsLanguage(this uintptr, value **uint16) uintptr {
	args := combridge.Resolve[iCoreWebView2EnvironmentOptions](this).Language()
	*value = stringToOleString(args)
	return uintptr(windows.S_OK)
}

func _iCoreWebView2EnvironmentTargetCompatibleBrowserVersion(this uintptr, value **uint16) uintptr {
	args := combridge.Resolve[iCoreWebView2EnvironmentOptions](this).TargetCompatibleBrowserVersion()
	*value = stringToOleString(args)
	return uintptr(windows.S_OK)
}

func _iCoreWebView2EnvironmentOptionsAllowSingleSignOnUsingOSPrimaryAccount(this uintptr, value *int32) uintptr {
	v := combridge.Resolve[iCoreWebView2EnvironmentOptions](this).AllowSingleSignOnUsingOSPrimaryAccount()
	*value = boolToInt(v)
	return uintptr(windows.S_OK)
}

func _iCoreWebView2EnvironmentOptions2ExclusiveUserDataFolderAccess(this uintptr, value *int32) uintptr {
	v := combridge.Resolve[iCoreWebView2EnvironmentOptions2](this).ExclusiveUserDataFolderAccess()
	*value = boolToInt(v)
	return uintptr(windows.S_OK)
}

// stringToOleString copies a string to memory of CoTaskMemAlloc, which the library frees.
func stringToOleString(v string) *uint16 {
	wstr := utf16.Encode([]rune(v + "\x00"))
	lwstr := len(wstr)
	ptr := (*uint16)(coTaskMemAlloc(2 * lwstr))

	copy(unsafe.Slice(ptr, lwstr), wstr)

	return ptr
}

func boolToInt(v bool) int32 {
	if v {
		return 1
	}
	return 0
}
