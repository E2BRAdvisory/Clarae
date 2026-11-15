//go:build !js

package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"clarae/apps/desktop/internal/webview"
)

var sweepNow = time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

// remember records a vault in the recent vaults with the date of its last opening.
func remember(t *testing.T, a *App, path string, last time.Time) string {
	t.Helper()
	if err := a.rememberVault(VaultInfo{Path: path, Name: filepath.Base(path), LastOpenedAt: last}); err != nil {
		t.Fatal(err)
	}
	return vaultID(path)
}

// storeOf gives a vault the entry of its session data, as opening an application does.
func storeOf(t *testing.T, a *App, id string) string {
	t.Helper()
	s, err := a.webviewStore(id)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func entryOf(t *testing.T, a *App, id string) (string, bool) {
	t.Helper()
	var v string
	err := a.appDB.QueryRow(`SELECT value FROM app_settings WHERE key = ?`, webviewStoreKey(id)).Scan(&v)
	return v, err == nil
}

func TestSweepDropsTheStoresOfVaultsThatNoLongerExist(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	long := sweepNow.AddDate(-1, 0, 0)
	base := t.TempDir() // a folder on the system drive, outside any mount root

	existing := filepath.Join(base, "existing")
	if err := os.Mkdir(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	type sweepCase struct {
		name string
		id   string
		gone bool
	}
	var cases []sweepCase
	add := func(name, id string, gone bool) { cases = append(cases, sweepCase{name, id, gone}) }
	// A recent vault whose date cannot be read: it is never judged.
	badDate := filepath.Join(base, "bad-date")
	if _, err := a.appDB.Exec(`INSERT INTO recent_vaults (path, name, last_opened_at) VALUES (?, 'x', 'yesterday-ish')`, badDate); err != nil {
		t.Fatal(err)
	}
	// A mount point of the user's choice with nothing mounted on it: an empty folder around the vault.
	mountPoint := filepath.Join(base, "GDrive")
	if err := os.Mkdir(mountPoint, 0o755); err != nil {
		t.Fatal(err)
	}
	// A folder that held only the vault, which was deleted: empty too (the known limit, kept).
	onlyChild := filepath.Join(base, "only-child")
	if err := os.Mkdir(onlyChild, 0o755); err != nil {
		t.Fatal(err)
	}
	// A mount (open, closed or revoked: the folder is what counts).
	mount := filepath.Join(a.mountsDir(), "0198a1b2-0000-7000-8000-000000000001")
	if err := os.MkdirAll(mount, 0o755); err != nil {
		t.Fatal(err)
	}
	mountAbs, _ := filepath.Abs(mount)

	// The vault that is open now, whatever its date.
	add("open", h.vaultID, false)
	add("recent, folder there", remember(t, a, existing, long), false)
	add("recent, folder deleted long ago", remember(t, a, filepath.Join(base, "deleted"), long), true)
	add("recent, folder deleted yesterday", remember(t, a, filepath.Join(base, "yesterday"), sweepNow.AddDate(0, 0, -1)), false)
	add("recent, a whole tree missing", remember(t, a, filepath.Join(base, "no", "tree", "vault"), long), false)
	add("recent, user mount point with nothing mounted", remember(t, a, filepath.Join(mountPoint, "Notes"), long), false)
	add("recent, deleted vault that was alone in its folder", remember(t, a, filepath.Join(onlyChild, "Notes"), long), false)
	add("recent, external disk that is not plugged in", remember(t, a, "/Volumes/ClaraeSweepTestDisk/Notes", long), false)
	add("recent, mounted share that is not there", remember(t, a, "/mnt/clarae-sweep-test/Notes", long), false)
	add("recent, date that cannot be read", vaultID(badDate), false)
	add("unknown to the application", "ffffffffffffffff", true)
	add("mount folder", vaultID(mountAbs), false)

	stores := map[string]string{}
	for _, c := range cases {
		stores[c.name] = storeOf(t, a, c.id)
	}

	n, err := a.sweepWebViewStores(context.Background(), sweepNow)
	if err != nil {
		t.Fatal(err)
	}
	want := 0
	for _, c := range cases {
		_, kept := entryOf(t, a, c.id)
		if kept == c.gone {
			t.Errorf("%s: entry kept = %v, want %v", c.name, kept, !c.gone)
		}
		removed := slices.Contains(h.fake.RemovedStores(), stores[c.name])
		if removed != c.gone {
			t.Errorf("%s: data of the platform deleted = %v, want %v", c.name, removed, c.gone)
		}
		if c.gone {
			want++
		}
	}
	if n != want {
		t.Errorf("dropped %d entries, want %d", n, want)
	}
	// Nothing was created or closed on the way: only data were deleted.
	for _, call := range h.fake.Calls() {
		if call != "remove-data" && call != "reserve-keys" {
			t.Errorf("unexpected call of the driver: %v", h.fake.Calls())
			break
		}
	}
}

// A vault that is opened after the sweep took its photograph of the known vaults is not swept: the last
// look before the deletion sees it.
func TestSweepSkipsAVaultOpenedMeanwhile(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	path := filepath.Join(t.TempDir(), "recreated")
	id := vaultID(path) // not recent, not a mount, not open: an orphan at the time of the photograph
	storeOf(t, a, id)
	testHookSweepBeforeRemove = func(string) {
		testHookSweepBeforeRemove = nil
		if _, err := a.openVault(path); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { testHookSweepBeforeRemove = nil })
	if n, err := a.sweepWebViewStores(context.Background(), sweepNow); err != nil || n != 0 {
		t.Fatalf("sweep: %d, %v", n, err)
	}
	if _, ok := entryOf(t, a, id); !ok || len(h.fake.RemovedStores()) != 0 {
		t.Fatalf("the data of a vault that is open were deleted: %v", h.fake.RemovedStores())
	}
}

func TestSweepKeepsTheEntryWhenThePlatformFails(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	id := "ffffffffffffffff"
	store := storeOf(t, a, id)
	h.fake.Fail(errors.New("WebKit does not answer"))
	if n, err := a.sweepWebViewStores(context.Background(), sweepNow); err != nil || n != 0 {
		t.Fatalf("sweep: %d, %v", n, err)
	}
	if v, ok := entryOf(t, a, id); !ok || v != store {
		t.Fatal("the entry went although the data were not deleted: nothing would ever try again")
	}
	// The next start finds it again and succeeds.
	if n, err := a.sweepWebViewStores(context.Background(), sweepNow); err != nil || n != 1 {
		t.Fatalf("second sweep: %d, %v", n, err)
	}
	if _, ok := entryOf(t, a, id); ok || !slices.Contains(h.fake.RemovedStores(), store) {
		t.Fatalf("second sweep did not finish: %v", h.fake.RemovedStores())
	}
}

// A store that was never created by the platform (an identifier nobody used) is not an error, and an
// entry that is not an identifier at all is dropped without asking the platform.
func TestSweepOfEntriesTheDriverNeverSaw(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	if _, err := a.appDB.Exec(`INSERT INTO app_settings (key, value) VALUES (?, 'not-a-uuid')`, webviewStoreKey("eeeeeeeeeeeeeeee")); err != nil {
		t.Fatal(err)
	}
	if _, err := a.appDB.Exec(`INSERT INTO app_settings (key, value) VALUES (?, ?)`, webviewStoreKey("dddddddddddddddd"), "0198a1b2-0000-7000-8000-00000000abcd"); err != nil {
		t.Fatal(err)
	}
	if n, err := a.sweepWebViewStores(context.Background(), sweepNow); err != nil || n != 2 {
		t.Fatalf("sweep: %d, %v", n, err)
	}
	if got := h.fake.RemovedStores(); len(got) != 1 || got[0] != "0198a1b2-0000-7000-8000-00000000abcd" {
		t.Fatalf("data deleted for %v", got)
	}
}

func TestSweepLeavesOtherSettingsAlone(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	if _, err := a.appDB.Exec(`INSERT INTO app_settings (key, value) VALUES ('webview_store', 'x'), ('webviewstore:aa', 'x'), ('other:ffffffffffffffff', 'x')`); err != nil {
		t.Fatal(err)
	}
	if n, err := a.sweepWebViewStores(context.Background(), sweepNow); err != nil || n != 0 {
		t.Fatalf("sweep: %d, %v", n, err)
	}
	var c int
	_ = a.appDB.QueryRow(`SELECT count(*) FROM app_settings WHERE value = 'x'`).Scan(&c)
	if c != 3 {
		t.Fatalf("a setting that is not a store was touched (%d left)", c)
	}
}

// Without a driver: where the platform has none, the entries alone go; where it may still come (the window
// does not exist yet), nothing is forgotten, so that the data are not left behind.
func TestSweepWithoutADriver(t *testing.T) {
	a, _, _ := newWVApp(t)
	id := "ffffffffffffffff"
	storeOf(t, a, id)

	// A host that has no way to hold views.
	if a.webviewDriverExpected() {
		t.Fatal("a headless application expects a driver")
	}
	if n, err := a.sweepWebViewStores(context.Background(), sweepNow); err != nil || n != 1 {
		t.Fatalf("no driver, none expected: %d, %v", n, err)
	}
	if _, ok := entryOf(t, a, id); ok {
		t.Fatal("the entry of a platform without views stayed")
	}

	// A platform whose driver is not there yet.
	storeOf(t, a, id)
	a.opts.NativeViews = func() webview.Driver { return nil }
	if !a.webviewDriverExpected() {
		t.Fatal("a driver that may come is not expected")
	}
	if n, err := a.sweepWebViewStores(context.Background(), sweepNow); err != nil || n != 0 {
		t.Fatalf("driver not there yet: %d, %v", n, err)
	}
	if _, ok := entryOf(t, a, id); !ok {
		t.Fatal("the entry went before the platform could delete its data")
	}
}

// What the host says about its build decides whether a driver is expected.
type viewsHost struct {
	headlessHost
	supported *bool
}

func (h viewsHost) NativeViews() webview.Driver { return nil }

type viewsHostWithSupport struct{ viewsHost }

func (h viewsHostWithSupport) NativeViewsSupported() bool { return *h.supported }

func TestDriverExpectedFollowsTheHost(t *testing.T) {
	a, _, _ := newWVApp(t)
	yes, no := true, false
	for _, c := range []struct {
		name string
		host Host
		want bool
	}{
		{"host with views and no word on its build", viewsHost{}, true},
		{"host that says it has a driver", viewsHostWithSupport{viewsHost{supported: &yes}}, true},
		{"host that says it has none", viewsHostWithSupport{viewsHost{supported: &no}}, false},
		{"host without views", headlessHost{}, false},
	} {
		a.host = c.host
		if got := a.webviewDriverExpected(); got != c.want {
			t.Errorf("%s: expected = %v, want %v", c.name, got, c.want)
		}
	}
}

// The sweep that Startup starts waits for the driver, runs by itself and never blocks the caller.
func TestStartedSweepWaitsForTheDriverAndRuns(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	id := "ffffffffffffffff"
	store := storeOf(t, a, id)
	ready := make(chan struct{})
	a.opts.NativeViews = func() webview.Driver {
		select {
		case <-ready:
			return h.fake
		default:
			return nil
		}
	}
	// The Manager of the harness has already resolved the driver; build one that has not.
	a.views.m = webview.NewManager(webview.Options{Driver: func() webview.Driver { return a.opts.NativeViews() }, Emit: a.emit, Logger: a.logger})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.startWebViewSweep(ctx)
	time.Sleep(50 * time.Millisecond)
	if _, ok := entryOf(t, a, id); !ok {
		t.Fatal("swept before the driver existed")
	}
	close(ready)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, ok := entryOf(t, a, id); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the sweep did not run once the driver existed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !slices.Contains(h.fake.RemovedStores(), store) {
		t.Fatalf("data not deleted: %v", h.fake.RemovedStores())
	}
}

func TestRecentVaultGone(t *testing.T) {
	base := t.TempDir()
	missing := filepath.Join(base, "missing")
	file := filepath.Join(base, "a-file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	emptyDir := filepath.Join(base, "mount-point")
	if err := os.Mkdir(emptyDir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := sweepNow.AddDate(0, -3, 0).Format(time.RFC3339)
	fresh := sweepNow.AddDate(0, 0, -29).Format(time.RFC3339)
	future := sweepNow.AddDate(1, 0, 0).Format(time.RFC3339)
	for _, c := range []struct {
		name, path, last string
		want             bool
	}{
		{"deleted long ago", missing, old, true},
		{"deleted within the period", missing, fresh, false},
		{"date in the future", missing, future, false},
		{"no date", missing, "", false},
		{"there", base, old, false},
		{"a file where the folder was", file, old, false},
		{"below a file (not 'does not exist')", filepath.Join(file, "vault"), old, false},
		{"parent empty: a mount point with nothing mounted", filepath.Join(emptyDir, "vault"), old, false},
		{"parent missing", filepath.Join(base, "x", "y"), old, false},
		{"external disk", "/Volumes/Disk/Notes", old, false},
	} {
		if got := recentVaultGone(c.path, c.last, sweepNow); got != c.want {
			t.Errorf("%s: gone = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestOnRemovableVolume(t *testing.T) {
	for p, want := range map[string]bool{
		"/Volumes/Disk/Notes":            true,
		"/media/user/USB/Notes":          true,
		"/run/media/user/USB/Notes":      true,
		"/mnt/nas/Notes":                 true,
		"/Users/me/Notes":                false,
		"/home/me/Volumes/Notes":         false,
		"/home/me/mnt/Notes":             false,
		"/VolumesAndMore/Notes":          false,
		filepath.Join(os.TempDir(), "x"): false,
	} {
		if filepath.VolumeName(p) != "" {
			continue // Windows: the rule is about the drive, not these paths
		}
		if got := onRemovableVolume(p); got != want {
			t.Errorf("%s: %v, want %v", p, got, want)
		}
	}
}
