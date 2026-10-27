//go:build windows

package updater

import (
	"os/exec"
	"syscall"
)

// detach makes the child survive the parent and hides its console window.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200 | 0x08000000, HideWindow: true} // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
}
