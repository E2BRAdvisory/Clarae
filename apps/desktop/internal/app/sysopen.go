//go:build !js

package app

import (
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// systemOpenWait is how long a launcher (open, xdg-open, rundll32) may take to report a failure,
// such as no application for the type. One still running after it is taken as launched: some
// launchers on Linux stay until the application exits.
var systemOpenWait = 3 * time.Second

// openCommand is the launcher that opens path with its default application on goos.
func openCommand(goos, path string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", []string{"--", path}
	case "windows":
		return "rundll32.exe", []string{"url.dll,FileProtocolHandler", path}
	default:
		return "xdg-open", []string{path}
	}
}

// revealCommand shows path selected in the file manager of goos (its folder on Linux, where no
// file manager interface is common to every desktop).
func revealCommand(goos, path string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", []string{"-R", "--", path}
	case "windows":
		return "explorer.exe", []string{"/select," + path}
	default:
		return "xdg-open", []string{filepath.Dir(path)}
	}
}

// runLauncher starts a launcher and returns its failure if it exits with one within
// systemOpenWait; a launcher still running then is left to finish on its own.
func runLauncher(name string, args ...string) error {
	cmd := exec.Command(name, args...) //nolint:gosec // the path comes from FS.Resolve, executables refused
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		var exit *exec.ExitError
		switch {
		case err == nil:
			return nil
		case !errors.As(err, &exit):
			return err
		case name == "explorer.exe": // explorer.exe /select exits with 1 even when it worked
			return nil
		}
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%s: %s", name, msg)
		}
		return fmt.Errorf("%s exited with status %d", name, exit.ExitCode())
	case <-time.After(systemOpenWait):
		return nil
	}
}
