package watcher

import (
	"context"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/rs/zerolog"
)

// chanSource is a recursive source driven by the test.
type chanSource struct {
	events chan fsnotify.Event
	errs   chan error
}

func (s *chanSource) Recursive() bool               { return true }
func (s *chanSource) Add(string) error              { return nil }
func (s *chanSource) Close() error                  { return nil }
func (s *chanSource) Events() <-chan fsnotify.Event { return s.events }
func (s *chanSource) Errors() <-chan error          { return s.errs }

// A writer that never pauses must not hold back the delivery forever: past
// MaxWait the pending paths are flushed even though events keep coming.
func TestWatcherMaxWaitFlushesDuringContinuousActivity(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, t.TempDir(), Options{Debounce: 200 * time.Millisecond, MaxWait: 400 * time.Millisecond, ReconcileInterval: -1, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				w.Notify([]string{"log.md"})
			}
		}
	}()
	select {
	case ch := <-w.C():
		if len(ch.Paths) != 1 || ch.Paths[0] != "log.md" {
			t.Fatalf("paths = %v", ch.Paths)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("continuous activity postponed the delivery past MaxWait")
	}
}

// MaxWait never shortens the debounce.
func TestWatcherMaxWaitNotBelowDebounce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, t.TempDir(), Options{Debounce: time.Second, MaxWait: time.Millisecond, ReconcileInterval: -1, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	if w.opts.MaxWait != time.Second {
		t.Fatalf("MaxWait = %v", w.opts.MaxWait)
	}
}

// A kernel queue overflow loses events: it must turn into a reconciliation,
// not only a log line.
func TestWatcherOverflowRequestsReconcile(t *testing.T) {
	src := &chanSource{events: make(chan fsnotify.Event), errs: make(chan error, 1)}
	old := sourceFactory
	sourceFactory = func() (source, error) { return src, nil }
	defer func() { sourceFactory = old }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, t.TempDir(), Options{Debounce: 50 * time.Millisecond, ReconcileInterval: -1, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	src.errs <- fsnotify.ErrEventOverflow
	select {
	case ch := <-w.C():
		if !ch.Reconcile {
			t.Fatalf("got %+v, want a reconcile", ch)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("overflow did not request a reconciliation")
	}
}

// A batch the consumer does not take in time is postponed, not lost.
func TestWatcherSlowConsumerKeepsPaths(t *testing.T) {
	old := consumerTimeout
	consumerTimeout = 50 * time.Millisecond
	defer func() { consumerTimeout = old }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, t.TempDir(), Options{Debounce: 20 * time.Millisecond, ReconcileInterval: -1, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	// A full channel: the next flushes cannot deliver.
	for i := 0; i < cap(w.out); i++ {
		w.out <- Change{Paths: []string{"filler.md"}}
	}
	w.Notify([]string{"kept.md"})
	time.Sleep(300 * time.Millisecond) // several flush attempts time out
	deadline := time.After(5 * time.Second)
	for {
		select {
		case ch := <-w.C():
			for _, p := range ch.Paths {
				if p == "kept.md" {
					return
				}
			}
		case <-deadline:
			t.Fatal("kept.md was dropped")
		}
	}
}
