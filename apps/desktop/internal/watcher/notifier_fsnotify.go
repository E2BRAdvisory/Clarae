//go:build !js

package watcher

import "github.com/fsnotify/fsnotify"

// fsnotifySource is fsnotify: inotify on Linux, ReadDirectoryChangesW on
// Windows, kqueue as the macOS fallback. It watches one folder per Add.
type fsnotifySource struct{ *fsnotify.Watcher }

func (s fsnotifySource) Recursive() bool               { return false }
func (s fsnotifySource) Events() <-chan fsnotify.Event { return s.Watcher.Events }
func (s fsnotifySource) Errors() <-chan error          { return s.Watcher.Errors }

func newFsnotifySource() (source, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return fsnotifySource{w}, nil
}
