//go:build !js

package shell

import (
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"memobrain/apps/desktop/internal/app"
	"memobrain/apps/desktop/internal/events"
)

// CloseFlushTimeout bounds the wait for the frontend: a frontend that never answers (still loading,
// hung) does not keep the app open. The frontend gives up on its own writes a few seconds earlier.
const CloseFlushTimeout = 10 * time.Second

// Window is what the CloseGuard needs from the application: the emitter of Go → TypeScript events
// and a way to quit.
type Window interface {
	// Emitter returns the emitter of Go → TypeScript events.
	Emitter() events.Emitter
	// Quit asks the application to quit (it comes back through the guard).
	Quit()
}

// Clock is the timer of the guard.
type Clock interface {
	// After returns a channel that receives once d has elapsed.
	After(d time.Duration) <-chan time.Time
}

type realClock struct{}

func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// CloseOptions configure a CloseGuard; the zero Clock and Timeout mean the real clock and
// CloseFlushTimeout.
type CloseOptions struct {
	Window  Window
	Clock   Clock
	Timeout time.Duration
	// OnRelease is called once, when the guard stops holding (the second request, or the timeout):
	// from then on the application is going away, and the shell arms its watchdog. It runs outside
	// the guard's lock and must not block.
	OnRelease func()
}

// CloseGuard holds the first close request (window closed, Cmd+Q, Quit) until the frontend has
// flushed its open notes (no silent data loss, D-04). The second request quits.
//
// There is one guard, fed by every gesture: the WindowClosing hook of the window (the close button,
// Alt+F4; on macOS the hook is the only one that fires for the button) and Options.ShouldQuit
// (Cmd+Q, Quit from the frontend or the updater). Neither may block: on Windows and macOS both run
// on the main thread, so the event is emitted and the timeout watched in goroutines.
//
// States: idle → (first request) pending → (second request, or timeout) released. A released guard
// lets every later request through. Shutdown ends the wait and releases the guard too.
type CloseGuard struct {
	win     Window
	clock   Clock
	timeout time.Duration

	mu       sync.Mutex
	pending  bool
	release  bool
	answered chan struct{} // closed by the second request
	stop     chan struct{} // closed by Shutdown
	stopped  bool

	onRelease func()

	watcherExit func() // test hook: called when the timeout watcher ends (set before BeforeClose)
}

// NewCloseGuard builds the guard of a window.
func NewCloseGuard(o CloseOptions) *CloseGuard {
	g := &CloseGuard{win: o.Window, clock: o.Clock, timeout: o.Timeout, onRelease: o.OnRelease, stop: make(chan struct{})}
	if g.clock == nil {
		g.clock = realClock{}
	}
	if g.timeout <= 0 {
		g.timeout = CloseFlushTimeout
	}
	return g
}

// NewWailsCloseGuard is the guard of the Wails application with the real clock. The application is
// set once it exists (bind): the guard is built before it, because ShouldQuit is an option of
// application.New.
func NewWailsCloseGuard(onRelease func()) (*CloseGuard, *WailsWindow) {
	w := &WailsWindow{}
	return NewCloseGuard(CloseOptions{Window: w, OnRelease: onRelease}), w
}

// Request is a close request: true holds it (the application stays open and the frontend is asked
// to flush), false lets it through. Safe from any goroutine; it never blocks.
func (g *CloseGuard) Request() bool {
	g.mu.Lock()
	switch {
	case g.release:
		g.mu.Unlock()
		return false
	case g.pending:
		// The frontend has flushed (or the user insists): quit.
		g.release = true
		close(g.answered)
		g.mu.Unlock()
		g.released()
		return false
	}
	defer g.mu.Unlock()
	g.pending = true
	g.answered = make(chan struct{})
	answered := g.answered
	// app:before-close: the frontend writes its pending edits and calls Quit again.
	emitter := g.win.Emitter()
	go app.EventBeforeClose.Send(emitter)
	timeout := g.clock.After(g.timeout)
	exit := g.watcherExit
	go func() {
		if exit != nil {
			defer exit()
		}
		select {
		case <-answered:
		case <-g.stop:
		case <-timeout:
			g.mu.Lock()
			quit := !g.release
			g.release = true
			g.mu.Unlock()
			if quit {
				g.released()
				g.win.Quit()
			}
		}
	}()
	return true
}

func (g *CloseGuard) released() {
	if g.onRelease != nil {
		g.onRelease()
	}
}

// WindowClosing is the hook of the window's WindowClosing event.
func (g *CloseGuard) WindowClosing(e *application.WindowEvent) {
	if g.Request() {
		e.Cancel()
	}
}

// ShouldQuit is Options.ShouldQuit of the application.
func (g *CloseGuard) ShouldQuit() bool { return !g.Request() }

// Shutdown ends a wait in progress without quitting (the application is already shutting down) and
// releases the guard. It is idempotent: the shell may call it from more than one place.
func (g *CloseGuard) Shutdown() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.release = true
	if !g.stopped {
		g.stopped = true
		close(g.stop)
	}
}

// WailsWindow is the Wails application as the guard sees it. Bind gives it the application once it
// exists; until then there is nothing to emit to or to quit (the guard cannot be asked before the
// application runs).
type WailsWindow struct {
	mu  sync.Mutex
	app *application.App
}

// Bind sets the application.
func (w *WailsWindow) Bind(a *application.App) {
	w.mu.Lock()
	w.app = a
	w.mu.Unlock()
}

func (w *WailsWindow) get() *application.App {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.app
}

// Emitter sends through the application event manager. A signal has no data argument (the handler
// receives no payload).
func (w *WailsWindow) Emitter() events.Emitter {
	return func(name string, payload any) {
		a := w.get()
		if a == nil {
			return
		}
		if payload == nil {
			a.Event.Emit(name)
			return
		}
		a.Event.Emit(name, payload)
	}
}

func (w *WailsWindow) Quit() {
	if a := w.get(); a != nil {
		a.Quit()
	}
}
