//go:build !js

package app

import (
	"errors"
	"strings"

	"clarae/apps/desktop/internal/webview"
)

// WebViewAPI is the browser inside the tab of an application (M18, track E; ADR-0056 in proposal). The
// page of an application runs in a native web view that the shell adds to the window, above the web view
// of the application; this API opens, places and closes those views. It is the whole contract of the UI
// with them (internal/webview documents the rules, internal/shell/nativeview the platform):
//
//   - Bounds are fractions (0..1) of the content view of the window, origin top-left: the UI measures
//     the rectangle of its placeholder against its viewport and sends the ratios, so the number does not
//     depend on the pixel ratio of the display or on the zoom of the application. A native view is always
//     above the HTML: the UI hides it (SetVisible) whenever something of its own must be seen over it, and
//     when its tab is not the active one.
//   - The core never opens a view by itself. A tab restored with the layout loads nothing until the UI
//     calls Open for it.
//   - Every call that names a view names its vault too, and a view is reachable only through its own
//     vault. A vault that is not open, or is a private one that is locked, is refused; the views of a vault
//     are closed when the vault is closed or locked (the UI hears it from webview:closed) and all of them
//     when the application quits.
//   - The function needs the configuration flag features.web_viewer (Open refuses without it, and turning
//     it off closes the views) and a driver, which the capability embeddedBrowser tells (macOS, Windows and Linux, where the runtime is there).
//
// The events are webview:state, webview:blocked, webview:new-window, webview:download, webview:permission,
// webview:key, webview:load-error, webview:crashed, webview:focus and webview:closed.
//
// The errors are "<code>: <text>" (ErrCodeWebView*, vault-not-open, vault-locked); Close and CloseVault on a
// vault or a view that is already gone answer with a code the UI may ignore when it is tearing down.
type WebViewAPI struct{ app *App }

// NewWebViewAPI binds the API.
func NewWebViewAPI(a *App) *WebViewAPI { return &WebViewAPI{app: a} }

// WebViewStatus is what Status returns.
type WebViewStatus struct {
	// Available: this device has a driver. It is the capability embeddedBrowser; a UI reads it from
	// SettingsAPI.Capabilities.
	Available bool `json:"available"`
	// Enabled: the configuration profile has features.web_viewer on.
	Enabled bool `json:"enabled"`
	// PersistentData: cookies and storage of the applications survive a restart (false on a macOS
	// before 14: the session lasts as long as the application runs).
	PersistentData bool `json:"persistentData"`
	// MaxViewsPerVault is the number of views a vault can hold open at once.
	MaxViewsPerVault int `json:"maxViewsPerVault"`
}

// WebViewOpened is what Open returns.
type WebViewOpened struct {
	// ViewID names the view in every other call and event.
	ViewID string `json:"viewId"`
	// PersistentData: as in WebViewStatus.
	PersistentData bool `json:"persistentData"`
}

// Status says what this device and this configuration offer. It needs no vault.
func (w *WebViewAPI) Status() (WebViewStatus, error) {
	m := w.app.views.m
	return WebViewStatus{
		Available:        m.Available(),
		Enabled:          w.app.webviewEnabled(),
		PersistentData:   m.PersistentData(),
		MaxViewsPerVault: webview.MaxViewsPerVault,
	}, nil
}

// vault checks that the vault is open and, if it is private, unlocked.
func (w *WebViewAPI) vault(vaultID string) error {
	if _, err := w.app.vault(vaultID); err != nil {
		return coded(ErrCodeVaultNotOpen, "the vault is not open", err)
	}
	if w.app.sync.VaultLocked(vaultID) {
		return coded(ErrCodeVaultLocked, "the vault is locked", nil)
	}
	return nil
}

// Open creates a view of the vault on rawURL and returns its id. rawURL must be an http or https address
// without credentials (webview.ValidateURL); a private host (localhost, the local network) is accepted,
// because the user chose it, and then the page may stay in the private network by itself. The view is
// visible at bounds and loads at once; the UI has the state through webview:state.
func (w *WebViewAPI) Open(vaultID, rawURL string, bounds webview.Bounds) (WebViewOpened, error) {
	if err := w.vault(vaultID); err != nil {
		return WebViewOpened{}, err
	}
	if !w.app.webviewEnabled() {
		return WebViewOpened{}, coded(ErrCodeWebViewDisabled, "applications are turned off by the configuration", nil)
	}
	id, err := w.app.views.m.Open(vaultID, rawURL, bounds)
	if err != nil {
		return WebViewOpened{}, w.fail(err)
	}
	// The vault may have been closed, or locked, and the flag turned off, while the platform made the
	// view: what closes the views of a vault or of the function found none yet.
	err = w.vault(vaultID)
	if err == nil && !w.app.webviewEnabled() {
		err = coded(ErrCodeWebViewDisabled, "applications are turned off by the configuration", nil)
	}
	if err != nil {
		_ = w.app.views.m.Close(vaultID, id)
		return WebViewOpened{}, err
	}
	return WebViewOpened{ViewID: id, PersistentData: w.app.views.m.PersistentData()}, nil
}

// SetBounds places the view (fractions of the content view, see the type).
func (w *WebViewAPI) SetBounds(vaultID, viewID string, bounds webview.Bounds) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.SetBounds(vaultID, viewID, bounds) })
}

// SetVisible shows or hides the view; a hidden view keeps its page, and the web engine slows its timers
// (a tab in the background is not kept awake).
func (w *WebViewAPI) SetVisible(vaultID, viewID string, visible bool) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.SetVisible(vaultID, viewID, visible) })
}

// Navigate points the view at an address (the same rules as Open).
func (w *WebViewAPI) Navigate(vaultID, viewID, rawURL string) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.Navigate(vaultID, viewID, rawURL) })
}

// Back goes back in the history of the view.
func (w *WebViewAPI) Back(vaultID, viewID string) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.Back(vaultID, viewID) })
}

// Forward goes forward in the history of the view.
func (w *WebViewAPI) Forward(vaultID, viewID string) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.Forward(vaultID, viewID) })
}

// Reload loads the page of the view again.
func (w *WebViewAPI) Reload(vaultID, viewID string) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.Reload(vaultID, viewID) })
}

// Focus gives the view the keyboard focus (the UI calls it when the tab is activated, and after
// SetVisible(true)).
func (w *WebViewAPI) Focus(vaultID, viewID string) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.Focus(vaultID, viewID) })
}

// Close closes a view the UI is done with (its tab was closed). No event follows.
func (w *WebViewAPI) Close(vaultID, viewID string) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.Close(vaultID, viewID) })
}

// CloseVault closes every view of the vault (the UI is leaving it). No event follows: the UI knows.
func (w *WebViewAPI) CloseVault(vaultID string) error {
	return w.call(vaultID, func(m *webview.Manager) error {
		if !m.Available() {
			return webview.ErrUnavailable
		}
		m.CloseVaultQuietly(vaultID)
		return nil
	})
}

// ReserveKeys sets the key combinations that a view hands to the application instead of consuming
// them: when one is pressed while a view has the focus, the UI gets webview:key and runs its own command.
// The list replaces the previous one and applies to every view. The syntax is the one of
// webview.ParseAccelerator ("cmd+w", "ctrl+shift+tab", "f5"; ctrl or cmd required, text editing
// refused). It names no vault: the keys are the application's, whatever vault is open.
func (w *WebViewAPI) ReserveKeys(accelerators []string) error {
	return w.fail(w.app.views.m.ReserveKeys(accelerators))
}

// ClearData deletes the session data (cookies, local storage, caches) of the applications of the vault
// on this device. The views of the vault are closed first (webview:closed with reason data-cleared); the
// UI opens again the ones it wants. The data are never part of the vault or of its synchronization.
func (w *WebViewAPI) ClearData(vaultID string) error {
	return w.call(vaultID, func(m *webview.Manager) error { return m.ClearData(vaultID) })
}

// call checks the vault and runs f.
func (w *WebViewAPI) call(vaultID string, f func(*webview.Manager) error) error {
	if err := w.vault(vaultID); err != nil {
		return err
	}
	return w.fail(f(w.app.views.m))
}

// fail gives an error of internal/webview the code the UI branches on.
func (w *WebViewAPI) fail(err error) error {
	var ue *webview.URLError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &ue):
		return coded(ErrCodeWebViewInvalidURL, string(ue.Reason)+": "+urlReasonText[ue.Reason], err)
	case errors.Is(err, webview.ErrUnavailable):
		return coded(ErrCodeWebViewUnavailable, "the embedded browser is not available on this device", err)
	case errors.Is(err, webview.ErrNotFound):
		return coded(ErrCodeWebViewNotFound, "no such view", err)
	case errors.Is(err, webview.ErrLimit):
		return coded(ErrCodeWebViewLimit, "too many applications are open", err)
	case errors.Is(err, webview.ErrBounds):
		return coded(ErrCodeWebViewInvalidBounds, "the bounds must be fractions of the window between 0 and 1", err)
	case errors.Is(err, webview.ErrAccelerator):
		return coded(ErrCodeWebViewInvalidKey, strings.TrimPrefix(err.Error(), "invalid accelerator: "), err)
	case errors.Is(err, webview.ErrDriver):
		logBindingError(err)
		return coded(ErrCodeWebViewFailed, "the system could not do it; see the log", err)
	}
	return bindingError(err)
}

// urlReasonText says in a few words why an address was refused (the UI translates the reason).
var urlReasonText = map[webview.BlockReason]string{
	webview.BlockEmpty:       "no address",
	webview.BlockTooLong:     "the address is too long",
	webview.BlockCharacters:  "the address has a control, space or invisible character, or a backslash",
	webview.BlockMalformed:   "not an absolute address",
	webview.BlockScheme:      "only http and https addresses can be opened",
	webview.BlockCredentials: "an address with a user name or password is refused",
	webview.BlockHost:        "the host is not valid",
	webview.BlockPort:        "the port is not valid",
}
