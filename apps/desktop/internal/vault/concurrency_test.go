package vault

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"clarae/shared/hashing"
)

// The Wails bindings, the importer and the sync engine share one FS: the
// existence/hash check of WriteFile and the publication of the new content
// must be one atomic step, or the later of two writers silently replaces the
// earlier one (D-04).

const racers = 32

// race runs fn(i) for i in [0, racers) from racers goroutines released together.
func race(fn func(i int)) {
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			fn(i)
		}()
	}
	close(start)
	wg.Wait()
}

func TestConcurrentWriteSameExpectedHash(t *testing.T) {
	f := newTestFS(t)
	for round := range 20 {
		base, err := f.WriteFile("note.md", []byte(fmt.Sprintf("base %d", round)), "", false)
		if err != nil {
			t.Fatal(err)
		}
		errs := make([]error, racers)
		race(func(i int) {
			_, errs[i] = f.WriteFile("note.md", []byte(fmt.Sprintf("writer %d", i)), base.Hash, false)
		})
		winner := -1
		for i, err := range errs {
			switch {
			case err == nil:
				if winner >= 0 {
					t.Fatalf("round %d: writers %d and %d both passed the hash check", round, winner, i)
				}
				winner = i
			case !errors.Is(err, ErrHashMismatch):
				t.Fatalf("round %d: writer %d: %v", round, i, err)
			}
		}
		if winner < 0 {
			t.Fatalf("round %d: no writer succeeded", round)
		}
		got, err := f.ReadFile("note.md")
		if err != nil || string(got.Data) != fmt.Sprintf("writer %d", winner) {
			t.Fatalf("round %d: content %q (err=%v), want the winner's", round, got.Data, err)
		}
	}
	assertNoStaging(t, f.Root())
}

func TestConcurrentCreate(t *testing.T) {
	f := newTestFS(t)
	for round := range 20 {
		p := fmt.Sprintf("Dir/new %d.md", round)
		errs := make([]error, racers)
		race(func(i int) {
			_, errs[i] = f.WriteFile(p, []byte(fmt.Sprintf("creator %d", i)), "", true)
		})
		winner := soleWinner(t, errs, ErrExists)
		got, err := f.ReadFile(p)
		if err != nil || string(got.Data) != fmt.Sprintf("creator %d", winner) {
			t.Fatalf("round %d: content %q (err=%v), want the winner's", round, got.Data, err)
		}
	}
	assertNoStaging(t, filepath.Join(f.Root(), "Dir"))
}

// On a case-insensitive file system (macOS, Windows) A.md and a.md are the
// same file: concurrent creations of the two spellings must not replace each other.
func TestConcurrentCreateCaseVariants(t *testing.T) {
	f := newTestFS(t)
	if !caseInsensitive(t, f.Root()) {
		t.Skip("case-sensitive file system")
	}
	for round := range 20 {
		names := []string{fmt.Sprintf("Case %d.md", round), fmt.Sprintf("case %d.md", round)}
		errs := make([]error, racers)
		race(func(i int) {
			_, errs[i] = f.WriteFile(names[i%2], []byte(fmt.Sprintf("creator %d", i)), "", true)
		})
		winner := soleWinner(t, errs, ErrExists)
		got, err := f.ReadFile(names[0])
		if err != nil || string(got.Data) != fmt.Sprintf("creator %d", winner) {
			t.Fatalf("round %d: content %q (err=%v), want the winner's", round, got.Data, err)
		}
	}
}

// A file created by another program between the existence check and the
// publication is not replaced: create=true publishes with a hard link.
func TestCreateDoesNotReplaceExternalFile(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("the browser file system has no hard links")
	}
	f := newTestFS(t)
	target := filepath.Join(f.Root(), "race.md")
	setCrashHook(t, func(step string) {
		if step == stepBeforeRen {
			if err := os.WriteFile(target, []byte("external"), 0o644); err != nil {
				t.Error(err)
			}
		}
	})
	if _, err := f.WriteFile("race.md", []byte("ours"), "", true); !errors.Is(err, ErrExists) {
		t.Fatalf("create over an external file: %v", err)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "external" {
		t.Fatalf("external file replaced: %q (err=%v)", got, err)
	}
	assertNoStaging(t, f.Root())
}

// Without hard links create=true still works and the lock still excludes
// concurrent creators.
func TestCreateWithoutHardLinks(t *testing.T) {
	old := linkFile
	linkFile = func(string, string) error { return &os.LinkError{Op: "link", Err: syscall.ENOSYS} }
	t.Cleanup(func() { linkFile = old })
	f := newTestFS(t)
	errs := make([]error, racers)
	race(func(i int) {
		_, errs[i] = f.WriteFile("nolink.md", []byte(fmt.Sprintf("creator %d", i)), "", true)
	})
	winner := soleWinner(t, errs, ErrExists)
	got, err := f.ReadFile("nolink.md")
	if err != nil || string(got.Data) != fmt.Sprintf("creator %d", winner) {
		t.Fatalf("content %q (err=%v), want the winner's", got.Data, err)
	}
	assertNoStaging(t, f.Root())
}

// Writes, renames (files and folders), trash, delete and mkdir interleave
// without deadlocks, and no write lands half-way.
func TestMixedMutationsNoDeadlock(t *testing.T) {
	f := newTestFS(t)
	paths := []string{"a.md", "A.md", "b.md", "Dir/c.md", "Dir2/c.md", "Dir/Sub/d.md"}
	tolerated := func(err error) bool {
		return err == nil || errors.Is(err, fs.ErrNotExist) || errors.Is(err, ErrExists) ||
			errors.Is(err, ErrHashMismatch) || errors.Is(err, ErrIsDirectory) ||
			// A folder renamed or trashed under a concurrent write or rename.
			errors.Is(err, syscall.ENOTDIR) || errors.Is(err, syscall.ENOTEMPTY) || errors.Is(err, syscall.EEXIST)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		race(func(i int) {
			for j := range 40 {
				p := paths[(i+j)%len(paths)]
				q := paths[(i+2*j+1)%len(paths)]
				var err error
				switch (i + j) % 8 {
				case 0, 1:
					_, err = f.WriteFile(p, []byte(p), "", false)
				case 2:
					_, err = f.WriteFile(p, []byte(p), "", true)
				case 3:
					var c Content
					if c, err = f.ReadFile(p); err == nil {
						_, err = f.WriteFile(p, []byte(p+"!"), c.Hash, false)
					}
				case 4:
					err = f.Rename(p, q)
				case 5:
					err = f.Rename("Dir", "Dir2")
					if err == nil {
						err = f.Rename("Dir2", "Dir")
					}
				case 6:
					_, err = f.Trash(p)
				case 7:
					if j%2 == 0 {
						err = f.Delete(p)
					} else {
						err = f.Mkdir("Dir/Sub")
					}
				}
				if !tolerated(err) {
					t.Errorf("worker %d step %d: %v", i, j, err)
				}
			}
		})
	}()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("mutations deadlocked")
	}
	// Every file holds a complete write of some writer.
	err := f.Walk(func(e Entry) error {
		if e.IsDir || strings.HasPrefix(e.Path, ".trash") {
			return nil
		}
		c, err := f.ReadFile(e.Path)
		if err != nil {
			return err
		}
		body := strings.TrimSuffix(string(c.Data), "!")
		valid := false
		for _, p := range paths {
			valid = valid || body == p
		}
		if !valid {
			t.Errorf("%s holds %q, not a complete write", e.Path, c.Data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestOverwriteKeepsPermissions(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "js" {
		t.Skip("no POSIX permissions")
	}
	f := newTestFS(t)
	c, err := f.WriteFile("private.md", []byte("v1"), "", true)
	if err != nil {
		t.Fatal(err)
	}
	abs := filepath.Join(f.Root(), "private.md")
	if st, _ := os.Stat(abs); st.Mode().Perm() != 0o644 {
		t.Fatalf("new file mode %v, want 0644", st.Mode().Perm())
	}
	if err := os.Chmod(abs, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteFile("private.md", []byte("v2"), c.Hash, false); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(abs)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("mode after overwrite %v (err=%v), want 0600", st.Mode().Perm(), err)
	}
	if got, _ := os.ReadFile(abs); hashing.Sum(got).Hex() != hashing.Sum([]byte("v2")).Hex() {
		t.Fatalf("content %q", got)
	}
}

// soleWinner asserts exactly one nil error, every other one being loser.
func soleWinner(t *testing.T, errs []error, loser error) int {
	t.Helper()
	winner := -1
	for i, err := range errs {
		switch {
		case err == nil:
			if winner >= 0 {
				t.Fatalf("writers %d and %d both succeeded", winner, i)
			}
			winner = i
		case !errors.Is(err, loser):
			t.Fatalf("writer %d: %v, want %v", i, err, loser)
		}
	}
	if winner < 0 {
		t.Fatal("no writer succeeded")
	}
	return winner
}

func caseInsensitive(t *testing.T, dir string) bool {
	t.Helper()
	p := filepath.Join(dir, "CaseProbe")
	if err := os.WriteFile(p, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(p) }()
	_, err := os.Stat(filepath.Join(dir, "caseprobe"))
	return err == nil
}

func setCrashHook(t *testing.T, hook func(step string)) {
	t.Helper()
	crashHook = hook
	t.Cleanup(func() { crashHook = nil })
}

func assertNoStaging(t *testing.T, dir string) {
	t.Helper()
	if left := tmpFiles(t, dir); len(left) != 0 {
		t.Fatalf("staging files left behind: %v", left)
	}
}
