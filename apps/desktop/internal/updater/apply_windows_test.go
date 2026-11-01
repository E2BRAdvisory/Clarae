//go:build windows

package updater

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The real command runs on Windows: a stub installer in a folder whose name
// has a space, an apostrophe and an ampersand runs with /S, then the
// "executable" is started again.
func TestWindowsInstallerCommandRuns(t *testing.T) {
	if _, err := exec.LookPath("powershell.exe"); err != nil {
		t.Skip("powershell.exe not available")
	}
	dir := filepath.Join(t.TempDir(), "O'Brien & Co updates")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	installed := filepath.Join(dir, "installed.txt")
	relaunched := filepath.Join(dir, "relaunched.txt")
	installer := filepath.Join(dir, "setup (1).cmd")
	exe := filepath.Join(dir, "memobrain.cmd")
	if err := os.WriteFile(installer, []byte("@echo %1> \""+installed+"\"\r\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, []byte("@echo ok> \""+relaunched+"\"\r\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	gone := exec.Command("cmd.exe", "/c", "exit")
	if err := gone.Run(); err != nil {
		t.Fatal(err)
	}
	name, args := windowsInstallerCommand(installer, exe, gone.Process.Pid, os.Getenv("SystemRoot"))
	if out, err := exec.Command(name, args...).CombinedOutput(); err != nil { //nolint:gosec // test of our own command
		t.Fatalf("%v: %s", err, out)
	}
	got, err := os.ReadFile(installed)
	if err != nil || string(got) != "/S\r\n" {
		t.Fatalf("installer not run with /S: %q %v", got, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(relaunched); err == nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("the executable was not started again")
}
