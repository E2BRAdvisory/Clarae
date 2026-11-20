// Package nativeview is the driver of the native web views of the applications (M18, track E; M22): a web
// view of the platform, added as a child of the window of the application, above its own web view, to
// show the page of an application in a tab (internal/webview is the platform-independent core; this is
// the platform). ADR-0056 describes it, ADR-0062 extends it to Windows and Linux.
//
// macOS has a driver: a WKWebView added to the content view of the window, with the public API of Wails
// (NativeWindow and InvokeSync) and nothing patched (guest_darwin.m). A build of macOS without cgo has
// none.
//
// Windows has a driver (driver_windows.go, guest_windows.go): a second WebView2 controller on the window,
// with an environment and a user data folder of its own per vault, on a reduced copy of the binding of
// WebView2 that Wails keeps in its internal packages (webview2/, with its licenses). It is on by default, and
// falls back to the system browser when the runtime of WebView2 is missing or too old: New returns nil without
// a runtime, and a Create that finds the platform unable returns webview.ErrPlatformUnavailable, which the
// Manager answers with "unavailable" (and takes as the state of the whole session if no view was ever made).
//
// Linux has a driver (driver_linux.go, guest_linux.c) for the GTK3 build with cgo (the tags of the binding of
// Wails for GTK3: linux, cgo, gtk3, no purego): a WebKitWebView of WebKitGTK in a GtkOverlay that takes the place
// of the web view of Wails in the box of the window, with a WebKitWebContext and data folders of its own per vault.
// It needs WebKitGTK 2.40; with an older one, or a window that is not made as the driver expects (the graft in
// guest_linux.c), it falls back like the one of Windows. Any other build (GTK4, without cgo, purego) has none:
// driver_other.go, New returns nil.
//
// CLARAE_WEBVIEW=off turns the drivers of Windows and Linux off (switch.go); the page of an application then
// opens in the system browser. capabilities.go lists the three systems; SettingsAPI.Capabilities still says false
// when the driver cannot be had.
//
// Like the rest of internal/shell it may import Wails; internal/app, which also builds to WebAssembly,
// reaches it only through app.NativeViewHost.
package nativeview
