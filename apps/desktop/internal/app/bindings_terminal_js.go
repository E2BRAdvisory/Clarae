//go:build js

package app

// The browser build has no terminal: a page runs no processes (ADR-0064; capability "terminal"). The
// workbench hides the function, and TerminalAPI keeps its methods with the signatures of the desktop
// (bindings_terminal.go, the contract of the UI) so that the bindings are the same on both hosts; each
// one refuses with terminal-unavailable.

import "errors"

// errNoTerminal answers every TerminalAPI call in the browser.
var errNoTerminal = coded(ErrCodeTerminalUnavailable, "the terminal is not available in the browser", errors.ErrUnsupported)

// TerminalAPI is the integrated terminal: not available in the browser.
type TerminalAPI struct{ app *App }

// NewTerminalAPI binds the API.
func NewTerminalAPI(a *App) *TerminalAPI { return &TerminalAPI{app: a} }

// Open is not available in the browser.
func (t *TerminalAPI) Open(string, int, int) (TerminalSession, error) {
	return TerminalSession{}, errNoTerminal
}

// CanOpen is not available in the browser.
func (t *TerminalAPI) CanOpen(string) (TerminalOpenCheck, error) {
	return TerminalOpenCheck{}, errNoTerminal
}

// Write is not available in the browser.
func (t *TerminalAPI) Write(string, string) error { return errNoTerminal }

// Resize is not available in the browser.
func (t *TerminalAPI) Resize(string, int, int) error { return errNoTerminal }

// Close is not available in the browser.
func (t *TerminalAPI) Close(string) error { return errNoTerminal }

// List is not available in the browser.
func (t *TerminalAPI) List() ([]TerminalSession, error) { return nil, errNoTerminal }

// Snapshot is not available in the browser.
func (t *TerminalAPI) Snapshot(string) (TerminalSnapshot, error) {
	return TerminalSnapshot{}, errNoTerminal
}

// State is not available in the browser.
func (t *TerminalAPI) State() (TerminalState, error) { return TerminalState{}, errNoTerminal }

// Undock is not available in the browser.
func (t *TerminalAPI) Undock() error { return errNoTerminal }

// Dock is not available in the browser.
func (t *TerminalAPI) Dock() error { return errNoTerminal }
