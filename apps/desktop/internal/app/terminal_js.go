//go:build js

package app

// The browser build has no terminal: a page runs no processes. The Manager of internal/terminal stays
// out of the WebAssembly core; TerminalAPI keeps its methods (bindings_terminal_js.go), each of which
// refuses, and the capability terminal is false.

// terminalState holds nothing in the browser.
type terminalState struct{}

func (a *App) initTerminal() {}

func (a *App) shutdownTerminal() {}

func (a *App) closeReadOnlyTerminals(string) {}
