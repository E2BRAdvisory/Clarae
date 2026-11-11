//go:build !js

package shell

import (
	"sync"
	"testing"
	"time"

	"memobrain/apps/desktop/internal/app"
	"memobrain/apps/desktop/internal/events"
)

// fakeWindow records the events and the quits of the guard.
type fakeWindow struct {
	sent chan string // one entry per event sent
	quit chan struct{}
	mu   sync.Mutex
	nQ   int
}

func newFakeWindow() *fakeWindow {
	return &fakeWindow{sent: make(chan string, 8), quit: make(chan struct{}, 8)}
}

func (w *fakeWindow) Emitter() events.Emitter {
	return func(name string, payload any) {
		if payload != nil {
			panic("a signal has no payload")
		}
		w.sent <- name
	}
}

func (w *fakeWindow) Quit() {
	w.mu.Lock()
	w.nQ++
	w.mu.Unlock()
	w.quit <- struct{}{}
}

func (w *fakeWindow) quits() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.nQ
}

// fakeClock hands out timers that fire when the test says so.
type fakeClock struct {
	mu     sync.Mutex
	timers []chan time.Time
	asked  []time.Duration
}

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	c.timers = append(c.timers, ch)
	c.asked = append(c.asked, d)
	return ch
}

// fire expires the first timer the guard asked for (each test asks for one).
func (c *fakeClock) fire() { c.timers[0] <- time.Time{} }

func waitFor[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		panic("unreachable")
	}
}

func expectNone[T any](t *testing.T, ch <-chan T, what string) {
	t.Helper()
	select {
	case <-ch:
		t.Fatalf("unexpected %s", what)
	case <-time.After(50 * time.Millisecond):
	}
}

func newGuard() (*CloseGuard, *fakeWindow, *fakeClock) {
	w, c := newFakeWindow(), &fakeClock{}
	return NewCloseGuard(CloseOptions{Window: w, Clock: c}), w, c
}

func TestCloseGuardFirstRequestHoldsAndEmitsOnce(t *testing.T) {
	g, w, c := newGuard()
	if !g.Request() {
		t.Fatal("the first request must keep the app open")
	}
	if got := waitFor(t, w.sent, "app:before-close"); got != app.EventBeforeClose.Name() {
		t.Fatalf("event = %q, want %q", got, app.EventBeforeClose.Name())
	}
	if len(c.asked) != 1 || c.asked[0] != CloseFlushTimeout || CloseFlushTimeout != 10*time.Second {
		t.Fatalf("timeout asked = %v, want one of 10s", c.asked)
	}
	// A second request while pending is the answer of the frontend: it releases, with no new event.
	if g.Request() {
		t.Fatal("the second request must let the app quit")
	}
	expectNone(t, w.sent, "second app:before-close")
	// A released guard lets everything through and sends nothing.
	for range 3 {
		if g.Request() {
			t.Fatal("a released guard must not hold the app")
		}
	}
	expectNone(t, w.sent, "app:before-close after release")
	if w.quits() != 0 {
		t.Fatalf("quits = %d: the guard quits only on timeout", w.quits())
	}
	// The timer of an answered wait does nothing when it fires late.
	c.fire()
	expectNone(t, w.quit, "quit after an answered wait")
}

func TestCloseGuardTimeoutQuits(t *testing.T) {
	g, w, c := newGuard()
	if !g.Request() {
		t.Fatal("the first request must keep the app open")
	}
	waitFor(t, w.sent, "app:before-close")
	expectNone(t, w.quit, "quit before the timeout")
	c.fire()
	waitFor(t, w.quit, "the quit of the timeout")
	// Quit comes back through the guard and must pass.
	if g.Request() {
		t.Fatal("after the timeout the request must quit")
	}
	expectNone(t, w.sent, "event after the timeout")
	if w.quits() != 1 {
		t.Fatalf("quits = %d, want 1", w.quits())
	}
}

func TestCloseGuardShutdown(t *testing.T) {
	g, w, c := newGuard()
	exited := make(chan struct{})
	g.watcherExit = func() { close(exited) }
	g.Request()
	waitFor(t, w.sent, "app:before-close")
	g.Shutdown()
	g.Shutdown() // idempotent
	// The watcher ends on Shutdown alone: the timer has not fired.
	waitFor(t, exited, "the watcher to stop")
	c.fire() // the watcher is gone: a late timer must not quit an application that is shutting down
	expectNone(t, w.quit, "quit after Shutdown")
	if g.Request() {
		t.Fatal("a guard that was shut down must not hold the app")
	}
	// Shutdown of an idle guard is idempotent too, and also releases.
	g2, _, _ := newGuard()
	g2.Shutdown()
	g2.Shutdown()
	if g2.Request() {
		t.Fatal("a guard that was shut down must not hold the app")
	}
}

func TestCloseGuardDefaults(t *testing.T) {
	g := NewCloseGuard(CloseOptions{Window: newFakeWindow()})
	if g.timeout != 10*time.Second {
		t.Fatalf("default timeout = %v, want 10s", g.timeout)
	}
	if _, ok := g.clock.(realClock); !ok {
		t.Fatalf("default clock = %T", g.clock)
	}
}

// The requests of several gestures (button, Cmd+Q, runtime Quit) race: one held request and one
// event; the others are the answer that releases the guard, so a late timeout quits nobody.
func TestCloseGuardConcurrentRequests(t *testing.T) {
	g, w, c := newGuard()
	t.Cleanup(g.Shutdown)
	exited := make(chan struct{})
	g.watcherExit = func() { close(exited) }
	var wg sync.WaitGroup
	held := make(chan bool, 16)
	for range 16 {
		wg.Add(1)
		go func() { defer wg.Done(); held <- g.Request() }()
	}
	wg.Wait()
	close(held)
	n := 0
	for h := range held {
		if h {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d requests held the app, want exactly 1", n)
	}
	waitFor(t, w.sent, "app:before-close")
	expectNone(t, w.sent, "second app:before-close")
	// The watcher ended on the answer; a late timer must not quit.
	waitFor(t, exited, "the watcher to stop")
	c.fire()
	if w.quits() != 0 {
		t.Fatalf("quits = %d, want 0: the guard was answered", w.quits())
	}
}
