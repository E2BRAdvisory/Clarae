//go:build !js

package app

// The browser inside the tab of an application (M18, track E). The desktop core owns a webview.Manager;
// the driver behind it is the native web view of the platform, which only the desktop shell can give
// (macOS today). The browser build has none (webviews_js.go): the page of an application opens in a
// tab of the browser, and the capability embeddedBrowser is false there.

import (
	"database/sql"
	"errors"

	"github.com/google/uuid"

	"clarae/apps/desktop/internal/webview"
	flags "clarae/shared/features"
)

// webviewState is the Manager of the app.
type webviewState struct {
	m *webview.Manager
}

// initWebViews builds the Manager. The driver is looked up when the first call needs it: the native
// window does not exist yet when the App is built.
func (a *App) initWebViews() {
	a.views.m = webview.NewManager(webview.Options{
		Driver: func() webview.Driver {
			if a.opts.NativeViews != nil {
				return a.opts.NativeViews()
			}
			if h, ok := a.host.(NativeViewHost); ok {
				return h.NativeViews()
			}
			return nil
		},
		DataStore: a.webviewStore,
		Emit:      a.emit,
		// An address that a page asked to open in a new window, and that passed the rules of a
		// navigation, goes to the system browser.
		OpenExternal: func(u string) { a.host.OpenURL(a.ctxOrBackground(), u) },
		// What the user does in a view never reaches the web view of the application: the idle lock
		// of private vaults would take it for inactivity.
		OnActivity: a.sync.Activity,
		Logger:     a.logger,
	})
}

// webviewAvailable reports whether this device can show a view (there is a driver).
func (a *App) webviewAvailable() bool { return a.views.m.Available() }

// closeVaultWebViews closes the views of a vault that is being closed. It must not be called with
// a.mu held.
func (a *App) closeVaultWebViews(vaultID string) {
	a.views.m.CloseVault(vaultID, webview.ClosedVaultClosed)
}

// closeLockedWebViews is the hook of the sync manager for a private vault that was locked.
func (a *App) closeLockedWebViews(vaultID string) {
	a.views.m.CloseVault(vaultID, webview.ClosedVaultLocked)
}

// shutdownWebViews closes every view at exit, without waiting long for the platform.
func (a *App) shutdownWebViews() { a.views.m.Shutdown() }

// applyWebViewFlag closes every view when the configuration switches the function off.
func (a *App) applyWebViewFlag(cfg map[string]any) {
	if !webViewEnabled(cfg) {
		a.views.m.CloseAll(webview.ClosedDisabled)
	}
}

// webViewEnabled reads features.web_viewer, which is on unless the administrator turns it off (ADR-0060). The
// function is also gated by the capability embeddedBrowser (a driver exists): both must hold.
func webViewEnabled(cfg map[string]any) bool { return flags.Enabled(cfg, flags.WebViewer) }

// webviewEnabled is webViewEnabled for the configuration in force.
func (a *App) webviewEnabled() bool { return webViewEnabled(a.config.Current().Config) }

// webviewStoreKey is where the identifier of the session data of a vault is kept: in the application
// database, which is local to the device and outside the vault, so it never travels with the folder.
func webviewStoreKey(vaultID string) string { return "webview_store:" + vaultID }

// webviewStore returns the identifier of the session data (the website data store of the platform) of a
// vault, making a random one the first time. It is not derived from the vault id, which is a hash of the
// path: another vault that is later opened at the same path would inherit the cookies of the one that was
// there. forgetWebViewData drops it when the vault goes for good.
func (a *App) webviewStore(vaultID string) (string, error) {
	if a.appDB == nil {
		return webview.DataStoreID(vaultID), nil // no database (a tool that builds the App without one)
	}
	ctx := a.ctxOrBackground()
	key := webviewStoreKey(vaultID)
	get := func() (string, bool, error) {
		var id string
		err := a.appDB.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = ?`, key).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		if err == nil {
			_, perr := uuid.Parse(id)
			return id, perr == nil, nil
		}
		return "", false, err
	}
	if id, ok, err := get(); err != nil || ok {
		return id, err
	}
	// Two opens at once make one: the first insert wins, the other reads it.
	if _, err := a.appDB.ExecContext(ctx, `INSERT INTO app_settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value NOT GLOB '????????-????-????-????-????????????'`, key, uuid.NewString()); err != nil {
		return "", err
	}
	id, ok, err := get()
	if err == nil && !ok {
		err = errors.New("the identifier of the session data could not be kept")
	}
	return id, err
}

// forgetWebViewData deletes the session data of a vault that goes for good (a mount that is removed) and
// forgets their identifier, so that nothing opened at that path later inherits them. A folder that the
// user deletes outside the application cannot be told about: sweepWebViewStores finds its entry at a
// later start (webviews_sweep.go), after a period, and until then the same path reuses the identifier
// (or WebViewAPI.ClearData deletes it).
func (a *App) forgetWebViewData(vaultID string) {
	if a.appDB == nil {
		return
	}
	ctx := a.ctxOrBackground()
	var id string
	if err := a.appDB.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = ?`, webviewStoreKey(vaultID)).Scan(&id); err != nil {
		return // never opened an application: nothing was stored
	}
	if err := a.views.m.ClearData(vaultID); err != nil && !errors.Is(err, webview.ErrUnavailable) {
		a.logger.Warn().Err(err).Str("vault", vaultID).Msg("the session data of the applications of a removed vault could not be deleted")
	}
	if _, err := a.appDB.ExecContext(ctx, `DELETE FROM app_settings WHERE key = ?`, webviewStoreKey(vaultID)); err != nil {
		a.logger.Warn().Err(err).Str("vault", vaultID).Msg("forget the data store of a removed vault")
	}
}
