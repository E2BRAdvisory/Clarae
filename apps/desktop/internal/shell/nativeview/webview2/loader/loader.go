// Derived from Wails v3.1.0, internal/webview2/webviewloader (ISC, Copyright (c) 2020 John Chadwick,
// Copyright (c) 2022 Wails Project Developers), a port of OpenWebView2Loader. Reduced for Clarae.
// See NOTICE and LICENSE in internal/shell/nativeview/webview2.

//go:build windows

// Package loader makes a WebView2 environment without WebView2Loader.dll: it finds the installed runtime
// of WebView2 (the registry, then EmbeddedBrowserWebView.dll in its folder) and calls the entry point of
// that library that the official loader calls.
//
// It is a reduction of webviewloader, the port of OpenWebView2Loader to Go that Wails v3.1.0 keeps in its
// internal packages (see NOTICE in the folder above): what is left is the installed runtime of the
// stable and preview channels, a user data folder, and no other option. A fixed-version runtime, the
// canary preference, the version queries and the other options are not here: nothing calls them.
//
//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package loader

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"

	"clarae/apps/desktop/internal/shell/nativeview/webview2/combridge"
)

// HRESULT
//
// See https://docs.microsoft.com/en-us/windows/win32/seccrypto/common-hresult-values
type HRESULT int32

// ICoreWebView2Environment is the environment that was made, as a plain COM object: a caller that keeps
// it takes its own reference (AddRef) and lets go of it with Release.
type ICoreWebView2Environment = combridge.IUnknownImpl

// ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler receives the environment.
type ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler interface {
	// EnvironmentCompleted is called on the thread that asked for the environment, from its loop of
	// messages, once the environment is made or has failed.
	EnvironmentCompleted(errorCode HRESULT, createdEnvironment *ICoreWebView2Environment) HRESULT
}

type iCoreWebView2CreateCoreWebView2EnvironmentCompletedHandler interface {
	combridge.IUnknown
	ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
}

func init() {
	combridge.RegisterVTable[combridge.IUnknown, iCoreWebView2CreateCoreWebView2EnvironmentCompletedHandler](
		"{4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d}",
		_iCoreWebView2CreateCoreWebView2EnvironmentCompletedHandlerInvoke,
	)
}

func _iCoreWebView2CreateCoreWebView2EnvironmentCompletedHandlerInvoke(this uintptr, errorCode HRESULT, env *combridge.IUnknownImpl) uintptr {
	res := combridge.Resolve[iCoreWebView2CreateCoreWebView2EnvironmentCompletedHandler](this).EnvironmentCompleted(errorCode, env)
	return uintptr(res) //nolint:gosec // the HRESULT travels in a register
}

// Option changes what CreateCoreWebView2EnvironmentWithOptions makes.
type Option func(*environmentOptions)

// WithUserDataFolder sets the user data folder of the environment: an absolute path. Environments of the
// same folder share a browser process, so they must be made with the same options.
func WithUserDataFolder(folder string) Option {
	return func(o *environmentOptions) { o.userDataFolder = folder }
}

// CreateCoreWebView2EnvironmentWithOptions makes an environment with the installed runtime of WebView2.
// It returns once the request is made: the handler is called later (see its interface).
//
// See https://docs.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/webview2-idl?#createcorewebview2environmentwithoptions
func CreateCoreWebView2EnvironmentWithOptions(handler ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, opts ...Option) error {
	var params environmentOptions
	for _, opt := range opts {
		opt(&params)
	}
	dllPath, _, err := findInstalledClientDll()
	if err != nil {
		return err
	}
	return createWebViewEnvironmentWithClientDll(dllPath, params.userDataFolder, &params, handler)
}

// runtimeInstalled is the value of webView2RunTimeType for the runtime that is installed (not a fixed one).
const runtimeInstalled = 0x00

func createWebViewEnvironmentWithClientDll(lpLibFileName, userDataFolder string, envOptions *environmentOptions, envCompletedHandler ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler) error {
	if !filepath.IsAbs(lpLibFileName) {
		return fmt.Errorf("lpLibFileName must be absolute")
	}

	dll, err := windows.LoadDLL(lpLibFileName)
	if err != nil {
		return fmt.Errorf("loading the library of WebView2 failed: %w", err)
	}

	defer func() {
		canUnloadProc, err := dll.FindProc("DllCanUnloadNow")
		if err != nil {
			return
		}

		if r1, _, _ := canUnloadProc.Call(); r1 != windows.NO_ERROR {
			return
		}

		_ = dll.Release()
	}()

	createProc, err := dll.FindProc("CreateWebViewEnvironmentWithOptionsInternal")
	if err != nil {
		return fmt.Errorf("the entry point CreateWebViewEnvironmentWithOptionsInternal was not found: %w", err)
	}

	userDataPtr, err := windows.UTF16PtrFromString(userDataFolder)
	if err != nil {
		return err
	}

	envOptionsCom := combridge.New2[iCoreWebView2EnvironmentOptions, iCoreWebView2EnvironmentOptions2](
		envOptions, envOptions)

	defer func() { _ = envOptionsCom.Close() }()

	envCompletedCom := combridge.New[iCoreWebView2CreateCoreWebView2EnvironmentCompletedHandler](&environmentCreatedHandler{envCompletedHandler})
	defer func() { _ = envCompletedCom.Close() }()

	preventEnvAndRegistryOverrides()

	const unknown = 1
	hr, _, err := createProc.Call(
		uintptr(unknown),
		uintptr(runtimeInstalled),
		uintptr(unsafe.Pointer(userDataPtr)),
		envOptionsCom.Ref(),
		envCompletedCom.Ref())

	if hr != 0 {
		if err == nil || errors.Is(err, windows.ERROR_SUCCESS) {
			err = syscall.Errno(hr)
		}
		return err
	}

	return nil
}

type environmentCreatedHandler struct {
	originalHandler ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
}

func (r *environmentCreatedHandler) EnvironmentCompleted(errorCode HRESULT, createdEnvironment *ICoreWebView2Environment) HRESULT {
	if createdEnvironment != nil {
		// Asks the environment for its own interface, as the official WebView2Loader does.
		iidICoreWebView2Environment := windows.GUID{
			Data1: 0xb96d755e,
			Data2: 0x0319,
			Data3: 0x4e92,
			Data4: [8]byte{0xa2, 0x96, 0x23, 0x43, 0x6f, 0x46, 0xa1, 0xfc},
		}

		if err := createdEnvironment.QueryInterface(&iidICoreWebView2Environment, &createdEnvironment); err != nil {
			createdEnvironment = nil
			var errNo syscall.Errno
			if !errors.As(err, &errNo) {
				errNo = syscall.Errno(windows.E_FAIL)
			}
			errorCode = HRESULT(errNo) //nolint:gosec // an HRESULT is 32 bits
		}
	}

	_ = r.originalHandler.EnvironmentCompleted(errorCode, createdEnvironment)

	if createdEnvironment != nil {
		createdEnvironment.Release()
	}

	return HRESULT(windows.S_OK)
}

// preventEnvAndRegistryOverrides: the variables that WebView2 reads (and the registry overrides of the same
// names, which are looked up by existence, not by value) must not change what the application asked for.
func preventEnvAndRegistryOverrides() {
	_ = os.Setenv("WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER", "")
	_ = os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
	_ = os.Setenv("WEBVIEW2_RELEASE_CHANNEL_PREFERENCE", "0")
	_ = os.Setenv("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", "")
	_ = os.Setenv("WEBVIEW2_USER_DATA_FOLDER", "")
}
