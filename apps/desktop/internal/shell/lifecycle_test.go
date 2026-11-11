//go:build !js

package shell

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeCore struct {
	mu       sync.Mutex
	calls    []string
	startCtx context.Context
	stopCtx  context.Context
	// observed in Shutdown: was the context of Startup already cancelled?
	cancelledAtShutdown bool
	shutdownGate        chan struct{} // when set, Shutdown waits for it
}

func (c *fakeCore) Startup(ctx context.Context) {
	c.mu.Lock()
	c.calls = append(c.calls, "startup")
	c.startCtx = ctx
	c.mu.Unlock()
}
func (c *fakeCore) DomReady(context.Context) {
	c.mu.Lock()
	c.calls = append(c.calls, "domready")
	c.mu.Unlock()
}
func (c *fakeCore) Shutdown(ctx context.Context) {
	if c.shutdownGate != nil {
		<-c.shutdownGate
	}
	c.mu.Lock()
	c.calls = append(c.calls, "shutdown")
	c.stopCtx = ctx
	c.cancelledAtShutdown = ctx.Err() != nil
	c.mu.Unlock()
}
func (c *fakeCore) log() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.calls...)
}

func TestLifecycleContextOutlivesShutdown(t *testing.T) {
	core := &fakeCore{}
	l := NewLifecycle(core, nil)
	l.Start()
	l.Start() // idempotent
	if core.startCtx == nil || core.startCtx.Err() != nil {
		t.Fatal("Startup needs a live context")
	}
	l.Stop()
	if core.cancelledAtShutdown {
		t.Fatal("the context was cancelled before Shutdown: the core could not flush")
	}
	if core.startCtx.Err() == nil {
		t.Fatal("the context must be cancelled after Shutdown")
	}
	if got := core.log(); len(got) != 2 || got[0] != "startup" || got[1] != "shutdown" {
		t.Fatalf("calls = %v", got)
	}
}

// OnShutdown, ServiceShutdown and the return of Run all call Stop (wails#6368): the core shuts
// down once, whoever is first, and nobody returns before it is done.
func TestLifecycleStopIsIdempotentAndWaits(t *testing.T) {
	core := &fakeCore{shutdownGate: make(chan struct{})}
	l := NewLifecycle(core, nil)
	l.Start()
	var done atomic.Int32
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() { defer wg.Done(); l.Stop(); done.Add(1) }()
	}
	time.Sleep(50 * time.Millisecond)
	if done.Load() != 0 {
		t.Fatal("a Stop returned while the core was still shutting down")
	}
	close(core.shutdownGate)
	wg.Wait()
	n := 0
	for _, c := range core.log() {
		if c == "shutdown" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("Shutdown ran %d times, want 1 (%v)", n, core.log())
	}
}

func TestLifecycleStopReleasesTheGuardAndSkipsAnUnstartedCore(t *testing.T) {
	core := &fakeCore{}
	g, _, _ := newGuard()
	l := NewLifecycle(core, g)
	l.Stop() // ServiceShutdown after a start that never happened
	if got := core.log(); len(got) != 0 {
		t.Fatalf("an unstarted core was shut down: %v", got)
	}
	if g.Request() {
		t.Fatal("the guard must be released by Stop")
	}
	l.Start() // too late
	if len(core.log()) != 0 {
		t.Fatal("a stopped lifecycle must not start the core")
	}
}

func TestLifecycleDomReadyReachesTheCore(t *testing.T) {
	core := &fakeCore{}
	l := NewLifecycle(core, nil)
	l.Start()
	l.DomReady()
	l.DomReady() // a page reload sends it again
	if got := core.log(); len(got) != 3 || got[1] != "domready" || got[2] != "domready" {
		t.Fatalf("calls = %v", got)
	}
}

func TestWatchdogStopsTheCoreAndExitsOnce(t *testing.T) {
	core := &fakeCore{}
	l := NewLifecycle(core, nil)
	l.Start()
	var fire func()
	var armed []time.Duration
	l.afterFunc = func(d time.Duration, f func()) { armed = append(armed, d); fire = f }
	codes := make(chan int, 4)
	l.exit = func(c int) { codes <- c }
	l.ArmWatchdog()
	l.ArmWatchdog() // the guard and Quit both arm it
	if len(armed) != 1 || armed[0] != 3*time.Second || QuitWatchdog != 3*time.Second {
		t.Fatalf("armed = %v, want one timer of 3s", armed)
	}
	if len(codes) != 0 {
		t.Fatal("exited before the timer")
	}
	fire()
	if got := waitFor(t, codes, "the exit"); got != 0 {
		t.Fatalf("exit code %d, want 0", got)
	}
	if got := core.log(); got[len(got)-1] != "shutdown" {
		t.Fatalf("the core must be shut down before the exit: %v", got)
	}
}

// A watchdog that fires while a shutdown is still flushing waits for it: exiting then would cut
// the writes of the core.
func TestWatchdogWaitsForAShutdownInProgress(t *testing.T) {
	core := &fakeCore{shutdownGate: make(chan struct{})}
	l := NewLifecycle(core, nil)
	l.Start()
	l.afterFunc = func(_ time.Duration, f func()) { go f() }
	codes := make(chan int, 1)
	l.exit = func(c int) { codes <- c }
	go l.Stop()
	time.Sleep(20 * time.Millisecond)
	l.ArmWatchdog()
	expectNone(t, codes, "exit during the shutdown")
	close(core.shutdownGate)
	waitFor(t, codes, "the exit after the shutdown")
}

// The guard arms the watchdog when it lets a request through, not when it holds one.
func TestGuardReleaseArmsTheWatchdog(t *testing.T) {
	var released atomic.Int32
	w, c := newFakeWindow(), &fakeClock{}
	g := NewCloseGuard(CloseOptions{Window: w, Clock: c, OnRelease: func() { released.Add(1) }})
	if !g.Request() {
		t.Fatal("first request must hold")
	}
	waitFor(t, w.sent, "app:before-close")
	if released.Load() != 0 {
		t.Fatal("holding must not arm the watchdog")
	}
	if g.Request() {
		t.Fatal("second request must release")
	}
	g.Request()
	if released.Load() != 1 {
		t.Fatalf("OnRelease called %d times, want 1", released.Load())
	}
	// Timeout path.
	released.Store(0)
	w2, c2 := newFakeWindow(), &fakeClock{}
	g2 := NewCloseGuard(CloseOptions{Window: w2, Clock: c2, OnRelease: func() { released.Add(1) }})
	g2.Request()
	waitFor(t, w2.sent, "app:before-close")
	c2.fire()
	waitFor(t, w2.quit, "the quit of the timeout")
	if released.Load() != 1 {
		t.Fatalf("timeout path: OnRelease called %d times, want 1", released.Load())
	}
}
