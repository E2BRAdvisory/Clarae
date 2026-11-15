package webview

import "clarae/apps/desktop/internal/events"

// The events of the views (Go → TypeScript, listed in the registry of internal/app/events_registry.go).
// Every payload carries the id of the view and of its vault: the UI keeps the views of the vault it
// shows and drops the rest. They come only on the desktop, where there is a driver. The text fields
// (url, title, message) come from a page that is not trusted: show them as text, never as markup,
// and never follow a url without ValidateURL.
var (
	EventState = events.New[StatePayload]("webview:state",
		"Desktop: what a view of an application shows changed (address, title, loading, history).")
	EventBlocked = events.New[BlockedPayload]("webview:blocked",
		"Desktop: a navigation of a view was cancelled (a scheme or a host that is not allowed).")
	EventNewWindow = events.New[NewWindowPayload]("webview:new-window",
		"Desktop: the page of a view asked for a new window. Nothing opens in the application; `opened` says whether\n"+
			"the address went to the system browser.")
	EventDownload = events.New[DownloadPayload]("webview:download",
		"Desktop: a view refused a download.")
	EventPermission = events.New[PermissionPayload]("webview:permission",
		"Desktop: a page asked for a permission (camera, microphone, location, files) and was denied.")
	EventKey = events.New[KeyPayload]("webview:key",
		"Desktop: a reserved key combination was pressed while a view had the focus (WebViewAPI.ReserveKeys): run it as the application's own.")
	EventLoadError = events.New[LoadErrorPayload]("webview:load-error",
		"Desktop: a view could not load its page (a certificate error included: there is no way around it).")
	EventCrashed = events.New[CrashedPayload]("webview:crashed",
		"Desktop: the process that renders a view ended. Reload it, or close it.")
	EventFocus = events.New[FocusPayload]("webview:focus",
		"Desktop: a view took the keyboard focus (a click in it).")
	EventClosed = events.New[ClosedPayload]("webview:closed",
		"Desktop: the application closed views that the UI did not ask to close (the vault was closed or locked, its data\n"+
			"were cleared, the application is quitting).")
)

// CloseReason says why the core closed a view by itself.
type CloseReason string

// The reasons of EventClosed.
const (
	// ClosedVaultClosed: the vault was closed.
	ClosedVaultClosed CloseReason = "vault-closed"
	// ClosedVaultLocked: the vault is private and was locked (by hand, by the idle timeout, by a sync).
	ClosedVaultLocked CloseReason = "vault-locked"
	// ClosedDataCleared: WebViewAPI.ClearData.
	ClosedDataCleared CloseReason = "data-cleared"
	// ClosedDisabled: the configuration profile switched the function off (features.web_viewer).
	ClosedDisabled CloseReason = "disabled"
	// ClosedQuit: the application is quitting.
	ClosedQuit CloseReason = "quit"
)

// StatePayload accompanies EventState.
type StatePayload struct {
	ViewID       string `json:"viewId"`
	VaultID      string `json:"vaultId"`
	URL          string `json:"url"`
	Title        string `json:"title"`
	Loading      bool   `json:"loading"`
	CanGoBack    bool   `json:"canGoBack"`
	CanGoForward bool   `json:"canGoForward"`
}

// BlockedPayload accompanies EventBlocked.
type BlockedPayload struct {
	ViewID  string      `json:"viewId"`
	VaultID string      `json:"vaultId"`
	URL     string      `json:"url"`
	Reason  BlockReason `json:"reason"`
	// MainFrame: the top of the page was the target; false for a frame inside it.
	MainFrame bool `json:"mainFrame"`
}

// NewWindowPayload accompanies EventNewWindow.
type NewWindowPayload struct {
	ViewID  string `json:"viewId"`
	VaultID string `json:"vaultId"`
	URL     string `json:"url"`
	// Opened: the address passed ValidateURL and went to the system browser.
	Opened bool `json:"opened"`
	// Reason is why it was not opened (empty when it was).
	Reason BlockReason `json:"reason"`
}

// DownloadPayload accompanies EventDownload.
type DownloadPayload struct {
	ViewID  string `json:"viewId"`
	VaultID string `json:"vaultId"`
	URL     string `json:"url"`
}

// PermissionPayload accompanies EventPermission.
type PermissionPayload struct {
	ViewID  string `json:"viewId"`
	VaultID string `json:"vaultId"`
	// Permission names what was asked: "media-capture", "file-chooser", "orientation", ...
	Permission string `json:"permission"`
	// Origin is the host of the page that asked (may be empty).
	Origin string `json:"origin"`
}

// KeyPayload accompanies EventKey.
type KeyPayload struct {
	ViewID  string `json:"viewId"`
	VaultID string `json:"vaultId"`
	// Accelerator is in the canonical form of ParseAccelerator ("cmd+w").
	Accelerator string `json:"accelerator"`
}

// LoadErrorPayload accompanies EventLoadError.
type LoadErrorPayload struct {
	ViewID  string `json:"viewId"`
	VaultID string `json:"vaultId"`
	URL     string `json:"url"`
	// Message is the description of the platform (it may be in the language of the system).
	Message string `json:"message"`
	// Code is the code of the platform; only compare it with 0.
	Code int `json:"code"`
	// Certificate: the certificate of the server was refused. The core offers no bypass.
	Certificate bool `json:"certificate"`
}

// CrashedPayload accompanies EventCrashed.
type CrashedPayload struct {
	ViewID  string `json:"viewId"`
	VaultID string `json:"vaultId"`
}

// FocusPayload accompanies EventFocus.
type FocusPayload struct {
	ViewID  string `json:"viewId"`
	VaultID string `json:"vaultId"`
}

// ClosedPayload accompanies EventClosed.
type ClosedPayload struct {
	ViewID  string      `json:"viewId"`
	VaultID string      `json:"vaultId"`
	Reason  CloseReason `json:"reason"`
}
