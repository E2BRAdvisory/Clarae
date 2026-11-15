//go:build js

package app

// The browser build has no embedded browser (webviews_js.go): the page of an application opens in a tab
// of the browser, which the UI does by itself, and the workbench hides the function (capability
// "embeddedBrowser"). WebViewAPI keeps its methods, with the signatures of the desktop (bindings_webview.go,
// the contract of the UI), so the bindings are the same on both hosts; each one refuses.

import (
	"errors"

	"clarae/apps/desktop/internal/webview"
)

// errNoWebView answers every WebViewAPI call in the browser.
var errNoWebView = coded(ErrCodeWebViewUnavailable, "the embedded browser is not available in the browser: the page opens in a tab", errors.ErrUnsupported)

// WebViewAPI is the browser inside the tab of an application: not available in the browser.
type WebViewAPI struct{ app *App }

// NewWebViewAPI binds the API.
func NewWebViewAPI(a *App) *WebViewAPI { return &WebViewAPI{app: a} }

// WebViewStatus is what Status returns.
type WebViewStatus struct {
	Available        bool `json:"available"`
	Enabled          bool `json:"enabled"`
	PersistentData   bool `json:"persistentData"`
	MaxViewsPerVault int  `json:"maxViewsPerVault"`
}

// WebViewOpened is what Open returns.
type WebViewOpened struct {
	ViewID         string `json:"viewId"`
	PersistentData bool   `json:"persistentData"`
}

// Status is not available in the browser.
func (w *WebViewAPI) Status() (WebViewStatus, error) { return WebViewStatus{}, errNoWebView }

// Open is not available in the browser.
func (w *WebViewAPI) Open(string, string, webview.Bounds) (WebViewOpened, error) {
	return WebViewOpened{}, errNoWebView
}

// SetBounds is not available in the browser.
func (w *WebViewAPI) SetBounds(string, string, webview.Bounds) error { return errNoWebView }

// SetVisible is not available in the browser.
func (w *WebViewAPI) SetVisible(string, string, bool) error { return errNoWebView }

// Navigate is not available in the browser.
func (w *WebViewAPI) Navigate(string, string, string) error { return errNoWebView }

// Back is not available in the browser.
func (w *WebViewAPI) Back(string, string) error { return errNoWebView }

// Forward is not available in the browser.
func (w *WebViewAPI) Forward(string, string) error { return errNoWebView }

// Reload is not available in the browser.
func (w *WebViewAPI) Reload(string, string) error { return errNoWebView }

// Focus is not available in the browser.
func (w *WebViewAPI) Focus(string, string) error { return errNoWebView }

// Close is not available in the browser.
func (w *WebViewAPI) Close(string, string) error { return errNoWebView }

// CloseVault is not available in the browser.
func (w *WebViewAPI) CloseVault(string) error { return errNoWebView }

// ReserveKeys is not available in the browser.
func (w *WebViewAPI) ReserveKeys([]string) error { return errNoWebView }

// ClearData is not available in the browser.
func (w *WebViewAPI) ClearData(string) error { return errNoWebView }
