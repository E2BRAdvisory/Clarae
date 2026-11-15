//go:build js

package app

// The browser build has no embedded browser: a web view cannot be put inside the page, so the page of
// an application opens in a tab of the browser (the UI does it) and the capability embeddedBrowser is
// false. The Manager of internal/webview stays out of the WebAssembly core; WebViewAPI keeps its
// methods (bindings_webview_js.go), each of which refuses.

// webviewState holds nothing in the browser.
type webviewState struct{}

func (a *App) initWebViews() {}

func (a *App) webviewAvailable() bool { return false }

func (a *App) closeVaultWebViews(string) {}

func (a *App) closeLockedWebViews(string) {}

func (a *App) shutdownWebViews() {}

func (a *App) applyWebViewFlag(map[string]any) {}

func (a *App) forgetWebViewData(string) {}
