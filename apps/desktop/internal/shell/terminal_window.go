//go:build !js

package shell

import (
	"context"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// The separate window of the integrated terminal (M23, ADR-0064): the only window besides the main
// one. It shows the page terminal.html of the frontend (served from the same asset server, so behind
// the same Content-Security-Policy middleware as the main page) and nothing else: the shells live in
// the core (internal/terminal), the window only draws them.
//
// What the core asks of it is Open and Close (app.Host.OpenTerminalWindow, CloseTerminalWindow). What
// it tells the core is that the user closed it with the button of the system
// (app.TerminalWindowHost). That window does not go through the CloseGuard: the guard holds the main
// window until the frontend has flushed the notes, and the terminal has none.

const (
	terminalWindowName = "terminal"
	// terminalWindowURL is the page of the window, in the asset server of the application (frontend/dist).
	terminalWindowURL   = "/terminal.html"
	terminalWindowTitle = "Clarae notanda — Terminale"
)

// termWin is the window as the holder needs it.
type termWin interface {
	// Show unminimises, shows and focuses the window.
	Show()
	// Close closes the window. The system's close event arrives as closing, from the holder's hook.
	Close()
}

// terminalWindows keeps at most one terminal window. It is the logic of Host.OpenTerminalWindow, apart
// from Wails so that it can be tested.
type terminalWindows struct {
	// create makes the window and wires its close event to closing; it may wait for the UI thread.
	create func(closing func(termWin)) (termWin, error)

	mu       sync.Mutex
	win      termWin
	creating bool
	onClosed func()
}

// open shows the window, creating it the first time.
func (t *terminalWindows) open() error {
	t.mu.Lock()
	if w := t.win; w != nil {
		t.mu.Unlock()
		w.Show()
		return nil
	}
	if t.creating {
		t.mu.Unlock()
		return nil // another call is making it
	}
	t.creating = true
	t.mu.Unlock()

	// Not under the lock: creating waits for the UI thread, which may be in closing, waiting for the lock.
	w, err := t.create(t.closing)
	t.mu.Lock()
	t.creating = false
	if err == nil {
		t.win = w
	}
	t.mu.Unlock()
	return err
}

// close closes the window if it is open. The core did it: it is not told.
func (t *terminalWindows) close() {
	t.mu.Lock()
	w := t.win
	t.win = nil // before Close: the hook that the close fires then finds a window that is not the current one
	t.mu.Unlock()
	if w != nil {
		w.Close()
	}
}

// closing is the hook of the close event of a window: the user closed it with the button of the
// system (or the application is quitting and Wails destroys it). The core is told, outside the lock.
func (t *terminalWindows) closing(w termWin) {
	t.mu.Lock()
	if t.win != w {
		t.mu.Unlock()
		return // closed by the core, or an event repeated for a window already forgotten
	}
	t.win = nil
	cb := t.onClosed
	t.mu.Unlock()
	if cb != nil {
		cb()
	}
}

func (t *terminalWindows) setOnClosed(f func()) {
	t.mu.Lock()
	t.onClosed = f
	t.mu.Unlock()
}

// wailsTermWin adapts a Wails window.
type wailsTermWin struct{ w *application.WebviewWindow }

func (w wailsTermWin) Show() {
	w.w.UnMinimise()
	w.w.Show()
	w.w.Focus()
}

func (w wailsTermWin) Close() { w.w.Close() }

// terminalHolder is the holder of the Host: its windows are made with the Wails application the Host is given.
func (h *Host) terminalHolder() *terminalWindows {
	h.termOnce.Do(func() {
		h.term = &terminalWindows{create: h.createTerminalWindow}
	})
	return h.term
}

func (h *Host) createTerminalWindow(closing func(termWin)) (termWin, error) {
	a, main := h.application()
	if a == nil || main == nil {
		return nil, errNoApplication
	}
	w := a.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             terminalWindowName,
		Title:            terminalWindowTitle,
		URL:              terminalWindowURL,
		Width:            960,
		Height:           520,
		MinWidth:         360,
		MinHeight:        200,
		BackgroundColour: application.NewRGB(16, 43, 58), // Deep Navy, as the main window
		// The page handles its own drag and drop and its own context menu.
		EnableFileDrop:             false,
		DefaultContextMenuDisabled: true,
	})
	tw := wailsTermWin{w}
	// Only this window's hook: the close button of the main window keeps going through the CloseGuard.
	w.RegisterHook(events.Common.WindowClosing, func(*application.WindowEvent) { closing(tw) })
	return tw, nil
}

// OpenTerminalWindow opens the separate window of the terminal, or brings it forward.
func (h *Host) OpenTerminalWindow(context.Context) error { return h.terminalHolder().open() }

// CloseTerminalWindow closes the separate window if it is open, without telling the core.
func (h *Host) CloseTerminalWindow(context.Context) { h.terminalHolder().close() }

// SetTerminalWindowClosed is app.TerminalWindowHost: f is called when the user closes the separate
// window. It runs on the thread of the window and must not block.
func (h *Host) SetTerminalWindowClosed(f func()) { h.terminalHolder().setOnClosed(f) }
