//go:build js

package watcher

import "github.com/fsnotify/fsnotify"

// noSource never produces an event: nothing outside the Go core can change a vault in the browser,
// and the core reports its own writes through Watcher.Notify.
type noSource struct{}

func (noSource) Recursive() bool               { return true }
func (noSource) Add(string) error              { return nil }
func (noSource) Close() error                  { return nil }
func (noSource) Events() <-chan fsnotify.Event { return nil } // a nil channel blocks forever in select
func (noSource) Errors() <-chan error          { return nil }

func newSource() (source, error) { return noSource{}, nil }
