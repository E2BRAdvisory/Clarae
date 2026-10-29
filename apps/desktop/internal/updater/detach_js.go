//go:build js

package updater

import "os/exec"

// detach does nothing: there is no process to outlive in the browser, where the updater is disabled.
func detach(*exec.Cmd) {}
