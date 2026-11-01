//go:build !js && !darwin

package watcher

func newSource() (source, error) { return newFsnotifySource() }
