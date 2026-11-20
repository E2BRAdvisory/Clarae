//go:build !js && !windows

package terminal

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

// recorder collects the events of a Manager.
type recorder struct {
	mu     sync.Mutex
	output map[string][]OutputPayload
	exits  []ExitPayload
	layout []Mode
}

func newRecorder() *recorder { return &recorder{output: map[string][]OutputPayload{}} }

func (r *recorder) emit(name string, payload any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch p := payload.(type) {
	case OutputPayload:
		r.output[p.ID] = append(r.output[p.ID], p)
	case ExitPayload:
		r.exits = append(r.exits, p)
	case LayoutPayload:
		r.layout = append(r.layout, p.Mode)
	}
}

func (r *recorder) text(id string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var b strings.Builder
	for _, p := range r.output[id] {
		b.WriteString(p.Data)
	}
	return b.String()
}

func (r *recorder) events(id string) []OutputPayload {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]OutputPayload(nil), r.output[id]...)
}

func (r *recorder) exitsOf() []ExitPayload {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]ExitPayload(nil), r.exits...)
}

func (r *recorder) layouts() []Mode {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Mode(nil), r.layout...)
}

// eventually polls cond for a few seconds.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type fakeWindow struct {
	mu      sync.Mutex
	opens   int
	closes  int
	openErr error
	// stateInOpen is what State() said from inside Open (the page of the window asks it as it starts).
	state       func() Mode
	stateInOpen []Mode
}

func (w *fakeWindow) Open() error {
	var seen Mode
	if w.state != nil {
		seen = w.state() // not under w.mu: the manager's own lock is unrelated
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.opens++
	if w.state != nil {
		w.stateInOpen = append(w.stateInOpen, seen)
	}
	return w.openErr
}

func (w *fakeWindow) Close() {
	w.mu.Lock()
	w.closes++
	w.mu.Unlock()
}

func (w *fakeWindow) counts() (int, int) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.opens, w.closes
}

// The pieces of a multibyte sequence are never split: what waits is the whole, or nothing.
func TestCompletePrefix(t *testing.T) {
	euro := []byte("€") // e2 82 ac
	for _, tc := range []struct {
		in   []byte
		want int
	}{
		{nil, 0},
		{[]byte("abc"), 3},
		{euro, 3},
		{euro[:2], 0},
		{euro[:1], 0},
		{append([]byte("ab"), euro[:2]...), 2},
		{append([]byte("ab"), euro...), 5},
		{[]byte{0xff}, 1},             // not UTF-8 at all: sent (as U+FFFD), never held
		{[]byte{0x80, 0x80, 0x80}, 3}, // stray continuation bytes
		{[]byte("a\xf0\x9f\x98"), 1},  // three bytes of a four-byte emoji
		{[]byte("a\xf0\x9f\x98\x80"), 5},
	} {
		if got := completePrefix(tc.in); got != tc.want {
			t.Errorf("completePrefix(% x) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// A read that ends inside a character sends the character whole with the next one.
func TestFeedHoldsAnIncompleteSequence(t *testing.T) {
	rec := newRecorder()
	m := NewManager(Options{Emit: rec.emit, FlushDelay: time.Hour, KillAfter: time.Second})
	s := &session{m: m, info: Info{ID: "x"}, ring: newRing(1024)}
	euro := []byte("€")
	s.feed(append([]byte("ab"), euro[:2]...))
	s.flush(false)
	if got := rec.text("x"); got != "ab" {
		t.Fatalf("after the first read: %q, want %q", got, "ab")
	}
	s.feed(append(append([]byte(nil), euro[2:]...), 'c'))
	s.flush(false)
	if got := rec.text("x"); got != "ab€c" {
		t.Fatalf("after the second read: %q, want %q", got, "ab€c")
	}
	for _, e := range rec.events("x") {
		if !utf8.ValidString(e.Data) {
			t.Errorf("event %d is not valid UTF-8: %q", e.Seq, e.Data)
		}
	}
	// Bytes that are not UTF-8 become U+FFFD, in the event and in the ring alike.
	s.feed([]byte{'z', 0xff, 'y'})
	s.flush(true)
	if got, want := rec.text("x"), "ab€cz\uFFFDy"; got != want {
		t.Fatalf("text = %q, want %q", got, want)
	}
	if got := s.ring.text(); got != rec.text("x") {
		t.Fatalf("ring = %q, events = %q: they must be the same text", got, rec.text("x"))
	}
}

// Output is cut into events of at most FlushBytes, in order, with seq counting from 1.
func TestFeedSplitsLargeOutputAndNumbersEvents(t *testing.T) {
	rec := newRecorder()
	m := NewManager(Options{Emit: rec.emit, FlushDelay: time.Hour, FlushBytes: 100, KillAfter: time.Second})
	s := &session{m: m, info: Info{ID: "x"}, ring: newRing(1 << 20)}
	in := strings.Repeat("é", 400) // 800 bytes, 2 each: no cut may fall inside one
	s.feed([]byte(in))
	s.flush(true)
	evs := rec.events("x")
	if len(evs) < 8 {
		t.Fatalf("%d events for 800 bytes with FlushBytes 100", len(evs))
	}
	var got strings.Builder
	for i, e := range evs {
		if e.Seq != uint64(i+1) {
			t.Errorf("event %d has seq %d", i, e.Seq)
		}
		if len(e.Data) > 100 {
			t.Errorf("event %d has %d bytes", i, len(e.Data))
		}
		got.WriteString(e.Data)
	}
	if got.String() != in {
		t.Error("the events do not add up to the input")
	}
}

func TestWindowAndLayout(t *testing.T) {
	rec := newRecorder()
	w := &fakeWindow{}
	m := NewManager(Options{Emit: rec.emit, Window: w})
	w.state = m.State
	if m.State() != ModeDocked {
		t.Fatalf("a new manager is %q", m.State())
	}
	if err := m.Undock(); err != nil {
		t.Fatal(err)
	}
	if m.State() != ModeDetached {
		t.Fatalf("after Undock: %q", m.State())
	}
	if err := m.Undock(); err != nil { // already detached: the window is shown again, no second event
		t.Fatal(err)
	}
	if opens, _ := w.counts(); opens != 2 {
		t.Errorf("Open called %d times, want 2 (it brings the window forward)", opens)
	}
	if err := m.Dock(); err != nil {
		t.Fatal(err)
	}
	if _, closes := w.counts(); closes != 1 {
		t.Errorf("Close called %d times", closes)
	}
	if err := m.Dock(); err != nil { // already docked: nothing
		t.Fatal(err)
	}
	if _, closes := w.counts(); closes != 1 {
		t.Errorf("a second Dock closed the window again (%d)", closes)
	}
	want := []Mode{ModeDetached, ModeDocked}
	if got := rec.layouts(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("layout events %v, want %v", got, want)
	}
	// A window that cannot open leaves the panel where it was.
	w.openErr = fmt.Errorf("no window")
	if err := m.Undock(); err == nil || m.State() != ModeDocked {
		t.Errorf("Undock with a failing window: err %v, state %q", err, m.State())
	}
	// The state was detached, and announced, while the window was being made; it went back, announced too.
	want = []Mode{ModeDetached, ModeDocked, ModeDetached, ModeDocked}
	if got := rec.layouts(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("layout events after the failed Undock %v, want %v", got, want)
	}
	// The page of the window asks State as it starts, inside Open: it must already read detached.
	for i, seen := range w.stateInOpen {
		if seen != ModeDetached {
			t.Errorf("State() inside Open #%d = %q, want detached", i+1, seen)
		}
	}
	if len(w.stateInOpen) != 3 {
		t.Errorf("State() was read inside %d opens, want 3", len(w.stateInOpen))
	}
	// A late close notice for a window Dock closed does nothing.
	m.WindowClosedBySystem()
	if len(rec.exitsOf()) != 0 || len(rec.layouts()) != 4 {
		t.Error("WindowClosedBySystem on a docked panel did something")
	}
}

func TestUndockWithoutWindow(t *testing.T) {
	m := NewManager(Options{})
	if err := m.Undock(); err == nil {
		t.Error("Undock with no window succeeded")
	}
}
