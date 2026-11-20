//go:build !js

package shell

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeTermWin is a window that records what is asked of it.
type fakeTermWin struct {
	shows, closes atomic.Int32
}

func (w *fakeTermWin) Show()  { w.shows.Add(1) }
func (w *fakeTermWin) Close() { w.closes.Add(1) }

// newHolder returns a holder whose windows are fakes; made lists them, in order, and hooks keeps the
// close hook each one was given (what Wails would call when the user presses the close button).
func newHolder() (h *terminalWindows, made *[]*fakeTermWin, hooks *[]func(termWin)) {
	made, hooks = new([]*fakeTermWin), new([]func(termWin))
	h = &terminalWindows{create: func(closing func(termWin)) (termWin, error) {
		w := &fakeTermWin{}
		*made = append(*made, w)
		*hooks = append(*hooks, closing)
		return w, nil
	}}
	return h, made, hooks
}

// The window is made once; opening it again brings it forward.
func TestTerminalWindowOpenCreatesOnceAndShowsAfter(t *testing.T) {
	h, made, _ := newHolder()
	if err := h.open(); err != nil {
		t.Fatal(err)
	}
	if err := h.open(); err != nil {
		t.Fatal(err)
	}
	if len(*made) != 1 {
		t.Fatalf("%d windows made, want 1", len(*made))
	}
	if n := (*made)[0].shows.Load(); n != 1 {
		t.Errorf("the second open showed the window %d times, want 1", n)
	}
}

// The core closing the window (Dock) does not look like the user closing it: nothing ends, and the
// event that Wails fires for the close is ignored.
func TestTerminalWindowCoreCloseIsNotReported(t *testing.T) {
	h, made, hooks := newHolder()
	var told atomic.Int32
	h.setOnClosed(func() { told.Add(1) })
	_ = h.open()
	win := (*made)[0]
	h.close()
	if win.closes.Load() != 1 {
		t.Fatalf("the window was closed %d times", win.closes.Load())
	}
	(*hooks)[0](win) // what Wails fires for the close the core asked for
	if told.Load() != 0 {
		t.Error("a close the core asked for was reported as the user's")
	}
	h.close() // nothing open: no-op
	if win.closes.Load() != 1 {
		t.Error("closing twice closed the window twice")
	}
	// A new open makes a new window.
	_ = h.open()
	if len(*made) != 2 {
		t.Errorf("%d windows made after reopening, want 2", len(*made))
	}
}

// The user closing the window tells the core once, and the next open makes a new one.
func TestTerminalWindowClosedByTheUser(t *testing.T) {
	h, made, hooks := newHolder()
	var told atomic.Int32
	h.setOnClosed(func() { told.Add(1) })
	_ = h.open()
	win := (*made)[0]
	(*hooks)[0](win)
	(*hooks)[0](win) // Wails can fire the event more than once
	if told.Load() != 1 {
		t.Fatalf("the core was told %d times, want 1", told.Load())
	}
	if win.closes.Load() != 0 {
		t.Error("the holder closed a window the user had closed")
	}
	_ = h.open()
	if len(*made) != 2 {
		t.Errorf("%d windows made, want 2", len(*made))
	}
	// A late event of the old window does not touch the new one.
	(*hooks)[0](win)
	if told.Load() != 1 {
		t.Error("a stale event of a forgotten window was reported")
	}
	h.close()
	if (*made)[1].closes.Load() != 1 {
		t.Error("the new window was not closed")
	}
}

func TestTerminalWindowCreateFails(t *testing.T) {
	boom := errors.New("boom")
	var calls int
	h := &terminalWindows{create: func(func(termWin)) (termWin, error) { calls++; return nil, boom }}
	if err := h.open(); !errors.Is(err, boom) {
		t.Fatalf("open = %v", err)
	}
	if err := h.open(); !errors.Is(err, boom) || calls != 2 { // a failure is not remembered
		t.Fatalf("second open = %v after %d tries", err, calls)
	}
	h.close() // nothing to close
}

// Creating a window waits for the UI thread, which may be inside the close hook: the holder must not
// hold its lock while it creates.
func TestTerminalWindowCreateDoesNotHoldTheLock(t *testing.T) {
	var h *terminalWindows
	inCreate, release := make(chan struct{}), make(chan struct{})
	h = &terminalWindows{create: func(func(termWin)) (termWin, error) {
		close(inCreate)
		<-release
		return &fakeTermWin{}, nil
	}}
	done := make(chan struct{})
	go func() { defer close(done); _ = h.open() }()
	<-inCreate
	hookDone := make(chan struct{})
	go func() { defer close(hookDone); h.closing(&fakeTermWin{}) }() // the UI thread, in a hook
	select {
	case <-hookDone:
	case <-time.After(2 * time.Second):
		t.Fatal("the close hook waits for a window that is being created")
	}
	// A second open while one is being made does not make another window.
	if err := h.open(); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done
}

// The core is told outside the lock: it may call back into the holder (Dock closes the window).
func TestTerminalWindowClosedCallbackMayCallBack(t *testing.T) {
	h, made, hooks := newHolder()
	var wg sync.WaitGroup
	wg.Add(1)
	h.setOnClosed(func() { defer wg.Done(); h.close(); _ = h.open() })
	_ = h.open()
	(*hooks)[0]((*made)[0])
	wg.Wait()
	if len(*made) != 2 {
		t.Errorf("%d windows made", len(*made))
	}
}

// Before the application exists the host fails to open the window and ignores the close.
func TestHostTerminalWindowBeforeAttach(t *testing.T) {
	h := NewHost()
	ctx := context.Background()
	if err := h.OpenTerminalWindow(ctx); !errors.Is(err, errNoApplication) {
		t.Fatalf("OpenTerminalWindow before the application = %v", err)
	}
	h.CloseTerminalWindow(ctx)
	h.SetTerminalWindowClosed(func() {})
}
