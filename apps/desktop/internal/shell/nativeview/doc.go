// Package nativeview is the driver of the native web views of the applications (M18, track E): a web
// view of the platform, added as a child of the window of the application, above its own web view, to
// show the page of an application in a tab (internal/webview is the platform-independent core; this is
// the platform).
//
// Only macOS has a driver: a WKWebView added to the content view of the window, with the public API of
// Wails (NativeWindow and InvokeSync) and nothing patched (guest_darwin.m). On Windows and Linux there
// is none: New returns nil, the capability embeddedBrowser is false and the page of an application opens
// in the system browser. A build of macOS without cgo has none either.
//
// Like the rest of internal/shell it may import Wails; internal/app, which also builds to WebAssembly,
// reaches it only through app.NativeViewHost.
package nativeview
