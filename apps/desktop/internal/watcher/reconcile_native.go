//go:build !js

package watcher

import "time"

// defaultReconcileInterval: events can be missed on some volumes (network
// shares, some external disks), so the disk is compared every few minutes.
const defaultReconcileInterval = 5 * time.Minute
