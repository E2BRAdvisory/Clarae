//go:build !js

package app

// The integrated terminal (M23, ADR-0064). The desktop core owns a terminal.Manager; the window of
// its own that the panel can move to is the host's (Host.OpenTerminalWindow). The browser build has no
// terminal (terminal_js.go): a page runs no processes, and the capability terminal is false there.

import "clarae/apps/desktop/internal/terminal"

// terminalState is the Manager of the app.
type terminalState struct {
	m *terminal.Manager
}

// terminalWindow is the separate window as the Manager sees it: the host's.
type terminalWindow struct{ a *App }

func (w terminalWindow) Open() error { return w.a.host.OpenTerminalWindow(w.a.ctxOrBackground()) }
func (w terminalWindow) Close()      { w.a.host.CloseTerminalWindow(w.a.ctxOrBackground()) }

// initTerminal builds the Manager. It starts nothing: a shell starts only when the user asks for one.
func (a *App) initTerminal() {
	a.terminal.m = terminal.NewManager(terminal.Options{
		Emit:   a.emit,
		Window: terminalWindow{a},
		Logger: a.logger.With().Str("module", "terminal").Logger(),
	})
	if h, ok := a.host.(TerminalWindowHost); ok {
		// The user closed the separate window: what lived in it ends. Ending the sessions waits for the
		// processes, and the host calls this from the thread of the window.
		h.SetTerminalWindowClosed(func() { go a.terminal.m.WindowClosedBySystem() })
	}
}

// shutdownTerminal ends every session at exit, within the watchdog of the quit.
func (a *App) shutdownTerminal() { a.terminal.m.Shutdown() }

// closeReadOnlyTerminals is the hook of the sync manager for a vault that became read-only (a share
// lowered to viewer or revoked): the shells that were opened in it end, with the reason. It runs on
// a goroutine of the sync manager, so the wait for the processes is left to a goroutine of its own.
func (a *App) closeReadOnlyTerminals(vaultID string) {
	go a.terminal.m.CloseVault(vaultID, terminal.ReasonReadOnly)
}
