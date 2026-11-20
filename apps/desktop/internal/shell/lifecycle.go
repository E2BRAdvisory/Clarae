//go:build !js

package shell

import (
	"context"
	"os"
	"sync"
	"time"
)

// QuitWatchdog is how long the application may take to exit once it has decided to: Wails v3 can
// leave Quit hanging (wails#6375), and the Windows updater waits for the executable to be released
// before it runs the installer. After it the process exits by itself, once the core has shut down.
const QuitWatchdog = 3 * time.Second

// Core is what the lifecycle starts and stops: *app.App.
type Core interface {
	Startup(ctx context.Context)
	DomReady(ctx context.Context)
	Shutdown(ctx context.Context)
}

// Lifecycle ties the core to the Wails application: Start from the start of the bridge service,
// Stop from every place that can end the application (OnShutdown, ServiceShutdown, the return of
// Run, the watchdog). Both are idempotent.
//
// The core gets a context of its own: Wails v3 cancels the context of the application before it
// runs the shutdown hooks, and the core uses its context to flush (indexes, sync, vaults), so it
// is cancelled here only after Shutdown.
type Lifecycle struct {
	core  Core
	guard *CloseGuard

	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	started bool
	stopped bool

	stopOnce sync.Once
	wdOnce   sync.Once

	// windows closes the windows besides the main one (the separate terminal) when the application stops.
	windows func()

	// replaced in tests
	afterFunc func(d time.Duration, f func())
	exit      func(code int)
}

// NewLifecycle returns the lifecycle of core; guard (may be nil) is released when it stops.
func NewLifecycle(core Core, guard *CloseGuard) *Lifecycle {
	ctx, cancel := context.WithCancel(context.Background())
	return &Lifecycle{
		core: core, guard: guard, ctx: ctx, cancel: cancel,
		afterFunc: func(d time.Duration, f func()) { time.AfterFunc(d, f) },
		exit:      os.Exit,
	}
}

// windowsCloseTimeout bounds the wait for the windows to close at stop: closing one needs the UI
// thread, which on quitting may be the one that is running Stop.
const windowsCloseTimeout = 500 * time.Millisecond

// CloseWindowsOnStop sets what Stop does about the windows besides the main one (the separate window of the terminal): f closes them
// before the core shuts down. Stop waits for it only briefly (windowsCloseTimeout); a window that is
// not closed by then goes with the process.
func (l *Lifecycle) CloseWindowsOnStop(f func()) {
	l.mu.Lock()
	l.windows = f
	l.mu.Unlock()
}

// Start starts the core with the context of the lifecycle. It never fails: the core reports what
// it cannot open through its host (a dialog that waits for the loop of the platform), and a
// service that fails to start would make Run return before a window exists.
func (l *Lifecycle) Start() {
	l.mu.Lock()
	if l.started || l.stopped {
		l.mu.Unlock()
		return
	}
	l.started = true
	l.mu.Unlock()
	l.core.Startup(l.ctx)
}

// DomReady forwards the "frontend ready" signal of the shim to the core: it delivers the
// clarae:// URLs that arrived before.
func (l *Lifecycle) DomReady() { l.core.DomReady(l.ctx) }

// Stop shuts the core down once, then cancels its context. Concurrent callers wait for the first
// one, so none returns while the core is still flushing.
func (l *Lifecycle) Stop() {
	l.stopOnce.Do(func() {
		l.mu.Lock()
		l.stopped = true
		started := l.started
		windows := l.windows
		l.mu.Unlock()
		if l.guard != nil {
			l.guard.Shutdown()
		}
		if windows != nil {
			done := make(chan struct{})
			go func() {
				defer close(done)
				windows()
			}()
			select {
			case <-done:
			case <-time.After(windowsCloseTimeout):
			}
		}
		if started {
			l.core.Shutdown(l.ctx)
		}
		l.cancel()
	})
}

// ArmWatchdog starts, once, the timer that ends the process if the application is still alive
// QuitWatchdog after it decided to quit. It stops the core first (the same Stop: a shutdown in
// progress is waited for, so no data is cut) and exits with 0.
func (l *Lifecycle) ArmWatchdog() {
	l.wdOnce.Do(func() {
		l.afterFunc(QuitWatchdog, func() {
			l.Stop()
			l.exit(0)
		})
	})
}
