//go:build js

package platform

import "errors"

// errInUse is what quiesceDatabase answers when another connection has the database open.
var errInUse = errors.New("the database is open in another process")

// quiesceDatabase is for the desktop only: a browser has no data directory of an earlier version
// to take over (DataDir is not called there).
func quiesceDatabase(string) error { return errors.New("not available in the browser build") }
