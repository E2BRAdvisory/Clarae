//go:build js

package watcher

// defaultReconcileInterval is off in the browser: only the core writes to the
// vault there and it reports every write through Notify, so a periodic walk
// of the whole OPFS vault would find nothing.
const defaultReconcileInterval = 0
