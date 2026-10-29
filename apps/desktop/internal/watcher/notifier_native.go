//go:build !js

package watcher

import "github.com/fsnotify/fsnotify"

type fsnotifySource struct{ *fsnotify.Watcher }

func (s fsnotifySource) Events() <-chan fsnotify.Event { return s.Watcher.Events }
func (s fsnotifySource) Errors() <-chan error          { return s.Watcher.Errors }

func newSource() (source, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return fsnotifySource{w}, nil
}
