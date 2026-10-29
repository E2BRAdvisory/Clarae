package vault

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"memobrain/shared/pathrules"
)

// Crash safety of WriteFile (Appendice A: "scritture client atomiche"). A child
// process runs the real writeAtomic and is terminated with os.Exit at one step
// (no deferred cleanup, like a power loss or SIGKILL); the parent then
// inspects the file system.

const crashEnv = "MEMOBRAIN_VAULT_CRASH_STEP"

var crashSteps = []string{stepTmpWritten, stepSynced, stepBeforeRen, stepRenamed}

func TestMain(m *testing.M) {
	if step := os.Getenv(crashEnv); step != "" {
		// Child: crash at the requested step.
		crashHook = func(s string) {
			if s == step {
				os.Exit(77)
			}
		}
		fs, err := NewFS(os.Getenv("MEMOBRAIN_VAULT_CRASH_ROOT"))
		if err != nil {
			os.Exit(2)
		}
		_, err = fs.WriteFile("Notes/crash.md", []byte(strings.Repeat("NEW CONTENT ", 20000)), "", false)
		if err != nil {
			os.Exit(3)
		}
		os.Exit(0) // the hook did not fire: the test notices the exit code
	}
	os.Exit(m.Run())
}

func runCrashChild(t *testing.T, root, step string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$") //nolint:gosec // re-executes this test binary to crash on purpose
	cmd.Env = append(os.Environ(), crashEnv+"="+step, "MEMOBRAIN_VAULT_CRASH_ROOT="+root)
	err := cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 77 {
		t.Fatalf("step %s: the child did not crash at the injection point (err=%v): fault not injected", step, err)
	}
}

func TestWriteAtomicCrashAtEveryStep(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("spawns a child process, which GOOS=js cannot do")
	}
	oldContent := strings.Repeat("OLD CONTENT ", 20000)
	newContent := strings.Repeat("NEW CONTENT ", 20000)
	for _, step := range crashSteps {
		for _, existed := range []bool{true, false} {
			name := step + "/overwrite"
			if !existed {
				name = step + "/create"
			}
			t.Run(name, func(t *testing.T) {
				root := t.TempDir()
				fs, err := NewFS(root)
				if err != nil {
					t.Fatal(err)
				}
				if existed {
					if _, err := fs.WriteFile("Notes/crash.md", []byte(oldContent), "", false); err != nil {
						t.Fatal(err)
					}
				} else if err := fs.Mkdir("Notes"); err != nil {
					t.Fatal(err)
				}
				runCrashChild(t, fs.Root(), step)

				got, readErr := os.ReadFile(filepath.Join(fs.Root(), "Notes", "crash.md"))
				switch {
				case step == stepRenamed:
					if readErr != nil || string(got) != newContent {
						t.Fatalf("after rename the new content must be in place (err=%v, %d bytes)", readErr, len(got))
					}
				case existed:
					if readErr != nil || string(got) != oldContent {
						t.Fatalf("crash before rename must leave the OLD content intact (err=%v, %d bytes)", readErr, len(got))
					}
				default:
					if readErr == nil {
						t.Fatalf("crash before rename must not create the target (found %d bytes)", len(got))
					}
				}

				// The staging file of a crash before rename is still there: it must be invisible.
				leftovers := tmpFiles(t, filepath.Join(fs.Root(), "Notes"))
				if step != stepRenamed && len(leftovers) != 1 {
					t.Fatalf("expected exactly the staging file of the crashed write, got %v", leftovers)
				}
				entries, err := fs.ListTree()
				if err != nil {
					t.Fatal(err)
				}
				for _, e := range entries {
					if strings.HasPrefix(e.Name, tmpPrefix) || pathrules.IsExcluded(e.Path, true) {
						t.Fatalf("stale staging file is visible to the app: %s", e.Path)
					}
				}
				for _, l := range leftovers {
					if !pathrules.IsExcluded("Notes/"+l, true) {
						t.Fatalf("%s would be synchronized: pathrules does not exclude it", l)
					}
				}

				// Recovery: a fresh start cleans what is old enough and leaves the target alone.
				for _, l := range leftovers {
					old := time.Now().Add(-time.Hour)
					_ = os.Chtimes(filepath.Join(fs.Root(), "Notes", l), old, old)
				}
				n, err := fs.CleanStaleTemp(time.Minute)
				if err != nil || n != len(leftovers) {
					t.Fatalf("CleanStaleTemp removed %d (err=%v), want %d", n, err, len(leftovers))
				}
				if left := tmpFiles(t, filepath.Join(fs.Root(), "Notes")); len(left) != 0 {
					t.Fatalf("staging files survived the cleanup: %v", left)
				}
				// The vault is fully usable afterwards.
				if _, err := fs.WriteFile("Notes/crash.md", []byte("recovered"), "", false); err != nil {
					t.Fatalf("write after recovery: %v", err)
				}
			})
		}
	}
}

func TestCleanStaleTempSparesRecentFiles(t *testing.T) {
	fs := newTestFS(t)
	p := filepath.Join(fs.Root(), tmpPrefix+"inflight")
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if n, _ := fs.CleanStaleTemp(time.Minute); n != 0 {
		t.Fatal("a write in progress was removed")
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal(err)
	}
}

func tmpFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), tmpPrefix) {
			out = append(out, e.Name())
		}
	}
	return out
}
