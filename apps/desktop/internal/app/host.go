package app

import (
	"context"

	"clarae/apps/desktop/internal/auth"
	"clarae/apps/desktop/internal/webview"
)

// Host is everything the application needs from the environment that runs it: the Wails window on
// the desktop (internal/shell) or the page that hosts the Go core compiled to WebAssembly in the
// browser (host_web.go, ADR-0030). Bindings never import Wails: they go through this interface.
// A method the browser does not support says which capability gates it ("Capability: x"), and
// HostMethodCapability lists it (ADR-0045 §1).
type Host interface {
	// Emit sends a Go → TypeScript event.
	Emit(ctx context.Context, name string, payload any)
	// SaveFile asks where to save a file and returns the chosen path ("" when cancelled).
	SaveFile(ctx context.Context, d SaveDialog) (string, error)
	// Delivered tells the host that the file at path, obtained from SaveFile, is complete. The
	// desktop has nothing to do; the browser starts the download.
	Delivered(ctx context.Context, path string)
	// OpenFile asks for a file to read and returns its path ("" when cancelled).
	OpenFile(ctx context.Context, d OpenDialog) (string, error)
	// OpenDirectory asks for a folder and returns its path ("" when cancelled).
	// Capability: localFolders (the browser has cloud vaults only: it returns an error).
	OpenDirectory(ctx context.Context, d OpenDialog) (string, error)
	// OpenURL opens a web page in the user's browser.
	OpenURL(ctx context.Context, url string)
	// Print opens the print dialog for the page.
	Print(ctx context.Context)
	// OpenPath opens a file (absolute path) with the application the operating system associates
	// with its type. The caller has refused executables (ADR-0047).
	// Capability: openWithSystemApp (the browser has no applications to hand a file to: it fails).
	OpenPath(ctx context.Context, path string) error
	// RevealPath shows a file (absolute path) selected in the system file manager.
	// Capability: openWithSystemApp (the browser has no file manager: it fails).
	RevealPath(ctx context.Context, path string) error
	// ShowWindow brings the application to the front.
	// Capability: nativeWindow (the browser has no window of its own to show: it does nothing).
	ShowWindow(ctx context.Context)
	// Quit closes the application.
	Quit(ctx context.Context)
	// ErrorDialog tells the user about a failure that stops the application.
	ErrorDialog(ctx context.Context, title, message string)
	// OpenTerminalWindow opens the separate window of the integrated terminal, or brings it forward
	// when it is open (ADR-0064). The window shows the page of the terminal; it does not start a shell.
	// Capability: terminal (the browser has no second window and no processes: it fails).
	OpenTerminalWindow(ctx context.Context) error
	// CloseTerminalWindow closes the separate window of the terminal, if open, without telling the core
	// that the user did it (TerminalWindowHost.SetTerminalWindowClosed).
	// Capability: terminal (the browser has no such window: it does nothing).
	CloseTerminalWindow(ctx context.Context)
}

// HostMethodCapability classifies every method of Host: the capability that gates it, or "" when
// every host supports it. A method that fails on some host is gated, and its capability is false
// there (TestHostCapabilities, which also fails on a method missing from this table).
var HostMethodCapability = map[string]Capability{
	"Emit":          "",
	"SaveFile":      "",
	"Delivered":     "",
	"OpenFile":      "",
	"OpenDirectory": CapLocalFolders,
	"OpenURL":       "",
	"Print":         "",
	"OpenPath":      CapOpenWithSystemApp,
	"RevealPath":    CapOpenWithSystemApp,
	"ShowWindow":    CapNativeWindow,
	"Quit":          "",
	"ErrorDialog":   "",

	"OpenTerminalWindow":  CapTerminal,
	"CloseTerminalWindow": CapTerminal,
}

// SessionHost is implemented by a host that owns the cloud sign-in: in the browser the page already
// holds an OIDC session, so the core takes its access tokens from the page (ADR-0029) instead of
// running the system-browser flow, and keeps vault keys in memory only.
type SessionHost interface {
	Session() *auth.Hosted
}

// TerminalWindowHost is implemented by a host whose separate terminal window can be closed by the
// user: the host calls the function it was given when that happens (the close button of the system,
// not CloseTerminalWindow), and the core ends the sessions that lived in it and docks the panel.
// The function does not block.
type TerminalWindowHost interface {
	SetTerminalWindowClosed(func())
}

// NativeViewHost is implemented by a host whose window can carry native web views, the browser
// inside the tab of an application (internal/webview). The desktop shell implements it where a driver
// exists (macOS); the browser host and the other systems do not, and the capability
// embeddedBrowser is false there.
type NativeViewHost interface {
	// NativeViews returns the driver, or nil while there is none (the window does not exist yet,
	// or the system has no driver). The core asks again until it gets one.
	NativeViews() webview.Driver
}

// NativeViewsSupport is implemented by a NativeViewHost that can say whether its build has a driver at
// all: NativeViews answers nil both while the window does not exist yet and for good where there is none.
// Without it the core must assume that a driver may still come.
type NativeViewsSupport interface {
	NativeViewsSupported() bool
}

// FileFilter restricts a file dialog to a kind of file (Pattern: "*.zip", or "*.md;*.txt").
type FileFilter struct {
	DisplayName string
	Pattern     string
}

// SaveDialog describes a "save as" request.
type SaveDialog struct {
	Title           string
	DefaultFilename string
	Filters         []FileFilter
}

// OpenDialog describes an "open file" or "open folder" request.
type OpenDialog struct {
	Title                string
	CanCreateDirectories bool
	Filters              []FileFilter
}
