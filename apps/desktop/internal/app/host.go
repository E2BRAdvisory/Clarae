package app

import (
	"context"

	"memobrain/apps/desktop/internal/auth"
)

// Host is everything the application needs from the environment that runs it: the Wails window on
// the desktop (host_wails.go) or the page that hosts the Go core compiled to WebAssembly in the
// browser (host_web.go, ADR-0030). Bindings never import Wails: they go through this interface.
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
	OpenDirectory(ctx context.Context, d OpenDialog) (string, error)
	// OpenURL opens a web page in the user's browser.
	OpenURL(ctx context.Context, url string)
	// Print opens the print dialog for the page.
	Print(ctx context.Context)
	// ShowWindow brings the application to the front.
	ShowWindow(ctx context.Context)
	// Quit closes the application.
	Quit(ctx context.Context)
	// ErrorDialog tells the user about a failure that stops the application.
	ErrorDialog(ctx context.Context, title, message string)
}

// SessionHost is implemented by a host that owns the cloud sign-in: in the browser the page already
// holds an OIDC session, so the core takes its access tokens from the page (ADR-0029) instead of
// running the system-browser flow, and keeps vault keys in memory only.
type SessionHost interface {
	Session() *auth.Hosted
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
