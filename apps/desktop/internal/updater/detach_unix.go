//go:build !windows && !js

package updater

import (
	"os/exec"
	"syscall"
)

// detach makes the child survive the parent (new session).
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
