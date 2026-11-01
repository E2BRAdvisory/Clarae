package app

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func setOpenVaultHook(t *testing.T, fn func()) {
	t.Helper()
	testHookOpenVault = fn
	t.Cleanup(func() { testHookOpenVault = nil })
}

// Concurrent opens of the same vault build it once and all get the same
// result: no duplicate indexer, watcher or history left unclosed.
func TestOpenVaultConcurrentSharesOneOpen(t *testing.T) {
	a, _, _ := newTestApp(t)
	var opens atomic.Int32
	setOpenVaultHook(t, func() {
		opens.Add(1)
		time.Sleep(50 * time.Millisecond) // keep the first open in flight while the others arrive
	})
	root := filepath.Join(t.TempDir(), "shared")
	const n = 8
	infos := make([]VaultInfo, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			infos[i], errs[i] = a.openVault(root)
		}()
	}
	wg.Wait()
	for i := range n {
		if errs[i] != nil {
			t.Fatalf("open %d: %v", i, errs[i])
		}
		if infos[i] != infos[0] {
			t.Errorf("open %d got %+v, want %+v", i, infos[i], infos[0])
		}
	}
	if got := opens.Load(); got != 1 {
		t.Errorf("vault built %d times, want 1", got)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.opening) != 0 {
		t.Errorf("%d opens still marked in progress", len(a.opening))
	}
	if _, ok := a.vaults[infos[0].ID]; !ok {
		t.Error("vault not registered")
	}
}

// A failed open is shared by the callers waiting on it and leaves no
// placeholder: the next call tries again (and succeeds once the cause is gone).
func TestOpenVaultConcurrentFailureLeavesNothing(t *testing.T) {
	a, _, _ := newTestApp(t)
	var opens atomic.Int32
	setOpenVaultHook(t, func() {
		opens.Add(1)
		time.Sleep(20 * time.Millisecond)
	})
	root := filepath.Join(t.TempDir(), "file-not-dir")
	if err := os.WriteFile(root, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var failed atomic.Int32
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := a.openVault(root); err != nil {
				failed.Add(1)
			}
		}()
	}
	wg.Wait()
	if failed.Load() != 4 {
		t.Fatalf("%d of 4 opens failed, want all", failed.Load())
	}
	a.mu.Lock()
	left, open := len(a.opening), len(a.vaults)
	a.mu.Unlock()
	if left != 0 || open != 1 { // only newTestApp's vault
		t.Fatalf("after failure: %d in progress, %d open", left, open)
	}
	before := opens.Load()
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if _, err := a.openVault(root); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if opens.Load() != before+1 {
		t.Error("retry did not open again")
	}
}
