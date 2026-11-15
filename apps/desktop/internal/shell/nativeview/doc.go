// Package nativeview is the driver of the native web views of the applications (M18, track E): a web
// view of the platform, added as a child of the window of the application, above its own web view, to
// show the page of an application in a tab (internal/webview is the platform-independent core; this is
// the platform).
//
// macOS has a driver: a WKWebView added to the content view of the window, with the public API of Wails
// (NativeWindow and InvokeSync) and nothing patched (guest_darwin.m). A build of macOS without cgo has
// none.
//
// Windows has a driver that is written and compiled but off (driver_windows.go, guest_windows.go): a
// second WebView2 controller on the window, with an environment and a user data folder of its own per
// vault, on a reduced copy of the binding of WebView2 that Wails keeps in its internal packages
// (webview2/, with its licenses). It has never run on a Windows machine, so New returns nil there, the
// capability embeddedBrowser is false and the page of an application opens in the system browser, unless
// the environment variable CLARAE_WEBVIEW2_EXPERIMENTAL is exactly "1" (a switch for whoever proves the
// driver: see experimentalEnv). capabilities.go still lists macOS only; it changes, together with
// Supported and the guides, when the matrix of manual tests has been run on Windows.
//
// Linux has none: New returns nil and the page opens in the system browser.
//
// Like the rest of internal/shell it may import Wails; internal/app, which also builds to WebAssembly,
// reaches it only through app.NativeViewHost.
package nativeview
