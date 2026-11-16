//go:build !js

package app

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/store"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/webview"
)

// wvHarness is an app whose native views are a webview.Fake, with the function turned on in the profile.
type wvHarness struct {
	a       *App
	vaultID string
	root    string
	fake    *webview.Fake

	mu     sync.Mutex
	events []recordedEvent
}

type recordedEvent struct {
	name    string
	payload any
}

// newWVApp is newTestApp with the keys of private vaults in memory: a test must never write to the
// keychain of the person who runs it.
func newWVApp(t *testing.T) (*App, VaultInfo, string) {
	t.Helper()
	ctx := context.Background()
	dataDir := t.TempDir()
	a := New(Options{DataDir: dataDir, Logger: zerolog.Nop(), Version: "test", KeyStore: crypto.NewMemoryStore()})
	a.ctx = ctx
	a.emitter = func(string, any) {}
	db, err := store.Open(ctx, filepath.Join(dataDir, "app.db"), store.KindApp)
	if err != nil {
		t.Fatal(err)
	}
	a.appDB = db
	root := filepath.Join(t.TempDir(), "vault")
	info, err := a.openVault(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		a.mu.Lock()
		for id, v := range a.vaults {
			a.closeVaultLocked(id, v)
		}
		a.mu.Unlock()
		_ = db.Close()
	})
	return a, info, root
}

func newWVHarness(t *testing.T) *wvHarness {
	t.Helper()
	a, info, root := newWVApp(t)
	h := &wvHarness{a: a, vaultID: info.ID, root: root, fake: webview.NewFake()}
	a.opts.NativeViews = func() webview.Driver { return h.fake }
	a.setEmitter(func(name string, payload any) {
		h.mu.Lock()
		h.events = append(h.events, recordedEvent{name, payload})
		h.mu.Unlock()
	})
	t.Cleanup(a.shutdownWebViews)
	refreshWith(t, a, map[string]any{"features": map[string]any{"web_viewer": true}})
	return h
}

func (h *wvHarness) api() *WebViewAPI { return NewWebViewAPI(h.a) }

// closed returns the payloads of the webview:closed events, oldest first.
func (h *wvHarness) closed() []any {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []any
	for _, e := range h.events {
		if e.name == "webview:closed" {
			out = append(out, e.payload)
		}
	}
	return out
}

func (h *wvHarness) order() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, e := range h.events {
		out = append(out, e.name)
	}
	return out
}

var wvBounds = webview.Bounds{X: 0.2, Y: 0.2, Width: 0.6, Height: 0.6}

func (h *wvHarness) open(t *testing.T) string {
	t.Helper()
	got, err := h.api().Open(h.vaultID, "https://example.com/app", wvBounds)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return got.ViewID
}

// makePrivate records in the sync database of the vault that it is linked to a private cloud vault, as
// Link would without a server, and attaches it again: the key is not in memory, so it is locked. It
// returns the cloud id.
func (h *wvHarness) makePrivate(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	const cloud = "00000000-0000-7000-8000-0000000000aa"
	sdb, err := store.Open(ctx, filepath.Join(h.root, ".clarae", "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	db := syncpkg.NewDB(sdb)
	for k, v := range map[string]string{syncpkg.MetaCloudVault: cloud, syncpkg.MetaKind: "private"} {
		if err := db.SetMeta(ctx, k, v); err != nil {
			t.Fatal(err)
		}
	}
	_ = sdb.Close()
	ov, err := h.a.vault(h.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.a.sync.Attach(ctx, h.vaultID, ov.FS); err != nil {
		t.Fatal(err)
	}
	return cloud
}

// unlock gives the key manager the key of the private vault.
func (h *wvHarness) unlock(t *testing.T, cloud string) {
	t.Helper()
	mat, err := h.a.crypto.NewMaterial("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.a.crypto.Adopt(cloud, mat); err != nil {
		t.Fatal(err)
	}
}

func TestWebViewAPIOpensAndDrivesAView(t *testing.T) {
	h := newWVHarness(t)
	api := h.api()
	st, err := api.Status()
	if err != nil || !st.Available || !st.Enabled || !st.PersistentData || st.MaxViewsPerVault != webview.MaxViewsPerVault {
		t.Fatalf("Status = %+v, %v", st, err)
	}
	got, err := api.Open(h.vaultID, "https://example.com/app", wvBounds)
	if err != nil || got.ViewID == "" || !got.PersistentData {
		t.Fatalf("Open = %+v, %v", got, err)
	}
	id := got.ViewID
	steps := map[string]error{
		"SetBounds":   api.SetBounds(h.vaultID, id, webview.Bounds{X: 0, Y: 0, Width: 1, Height: 1}),
		"SetVisible":  api.SetVisible(h.vaultID, id, false),
		"Navigate":    api.Navigate(h.vaultID, id, "https://example.org/"),
		"Back":        api.Back(h.vaultID, id),
		"Forward":     api.Forward(h.vaultID, id),
		"Reload":      api.Reload(h.vaultID, id),
		"Focus":       api.Focus(h.vaultID, id),
		"ReserveKeys": api.ReserveKeys([]string{"cmd+w", "ctrl+tab"}),
	}
	for name, err := range steps {
		if err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if keys := h.fake.Keys(); !slices.Equal(keys, []string{"cmd+w", "ctrl+tab"}) {
		t.Fatalf("keys %v", keys)
	}
	v, _ := h.fake.View(id)
	if store, err := h.a.webviewStore(h.vaultID); err != nil || v.DataStore != store || v.URL != "https://example.org/" || v.Visible {
		t.Fatalf("view %+v", v)
	}
	if err := api.Close(h.vaultID, id); err != nil {
		t.Fatal(err)
	}
	if len(h.fake.Views()) != 0 {
		t.Fatal("Close left the view")
	}
	if err := api.Close(h.vaultID, id); codeOf(err) != ErrCodeWebViewNotFound {
		t.Fatalf("Close twice = %v", err)
	}
	// CloseVault closes the lot, silently.
	h.open(t)
	h.open(t)
	if err := api.CloseVault(h.vaultID); err != nil || len(h.fake.Views()) != 0 {
		t.Fatalf("CloseVault = %v, %d views left", err, len(h.fake.Views()))
	}
	if n := len(h.closed()); n != 0 {
		t.Fatalf("%d closed events for a close the UI asked for", n)
	}
}

func TestWebViewAPIErrorsHaveCodes(t *testing.T) {
	h := newWVHarness(t)
	api := h.api()
	id := h.open(t)
	for _, tc := range []struct {
		name string
		err  error
		code string
		text string // the start of the text after the code
	}{
		{"scheme", func() error { _, err := api.Open(h.vaultID, "file:///etc/passwd", wvBounds); return err }(), ErrCodeWebViewInvalidURL, "webview-invalid-url: scheme: "},
		{"credentials", func() error { _, err := api.Open(h.vaultID, "https://u:p@example.com/", wvBounds); return err }(), ErrCodeWebViewInvalidURL, "webview-invalid-url: credentials: "},
		{"empty", func() error { _, err := api.Open(h.vaultID, "", wvBounds); return err }(), ErrCodeWebViewInvalidURL, "webview-invalid-url: empty: "},
		{"navigate", api.Navigate(h.vaultID, id, "javascript:alert(1)"), ErrCodeWebViewInvalidURL, "webview-invalid-url: scheme: "},
		{"bounds", api.SetBounds(h.vaultID, id, webview.Bounds{Width: 3, Height: 1}), ErrCodeWebViewInvalidBounds, ""},
		{"open bounds", func() error { _, err := api.Open(h.vaultID, "https://example.com/", webview.Bounds{X: -1}); return err }(), ErrCodeWebViewInvalidBounds, ""},
		{"unknown view", api.Reload(h.vaultID, "wv999"), ErrCodeWebViewNotFound, ""},
		{"keys", api.ReserveKeys([]string{"cmd+c"}), ErrCodeWebViewInvalidKey, "webview-invalid-accelerator: "},
		{"keys 2", api.ReserveKeys([]string{"w"}), ErrCodeWebViewInvalidKey, ""},
	} {
		if codeOf(tc.err) != tc.code {
			t.Errorf("%s: %v, want code %s", tc.name, tc.err, tc.code)
			continue
		}
		if !strings.HasPrefix(tc.err.Error(), tc.code+": "+strings.TrimPrefix(tc.text, tc.code+": ")) {
			t.Errorf("%s: text %q", tc.name, tc.err.Error())
		}
		if strings.Contains(tc.err.Error(), "example.com") || strings.Contains(tc.err.Error(), "passwd") {
			t.Errorf("%s: the error repeats the address: %v", tc.name, tc.err)
		}
	}
	// A failure of the platform is not detailed to the UI.
	h.fake.Fail(errors.New("/Users/someone/Library/WebKit: permission denied"))
	err := api.Reload(h.vaultID, id)
	if codeOf(err) != ErrCodeWebViewFailed || strings.Contains(err.Error(), "someone") {
		t.Fatalf("a platform failure: %v", err)
	}
	for i := 0; i < webview.MaxViewsPerVault; i++ {
		if _, err := api.Open(h.vaultID, "https://example.com/", wvBounds); err != nil {
			if codeOf(err) != ErrCodeWebViewLimit {
				t.Fatalf("view %d: %v", i, err)
			}
			return
		}
	}
	t.Fatal("no limit")
}

// The function is behind the flag of the profile: off, nothing opens; turned off later, what is open closes.
func TestWebViewAPIFollowsTheFlag(t *testing.T) {
	h := newWVHarness(t)
	id := h.open(t)
	refreshWith(t, h.a, map[string]any{"features": map[string]any{"web_viewer": false}})
	if _, ok := h.fake.View(id); ok {
		t.Fatal("the flag went off and the view stayed")
	}
	closed := h.closed()
	if len(closed) != 1 || closed[0].(webview.ClosedPayload).Reason != webview.ClosedDisabled || closed[0].(webview.ClosedPayload).VaultID != h.vaultID {
		t.Fatalf("closed events %+v", closed)
	}
	if _, err := h.api().Open(h.vaultID, "https://example.com/", wvBounds); codeOf(err) != ErrCodeWebViewDisabled {
		t.Fatalf("Open with the flag off = %v", err)
	}
	if st, _ := h.api().Status(); st.Enabled || !st.Available {
		t.Fatalf("Status = %+v", st)
	}
	// Without any profile, the default is on (ADR-0060).
	a, info, _ := newTestApp(t)
	a.opts.NativeViews = func() webview.Driver { return webview.NewFake() }
	t.Cleanup(a.shutdownWebViews)
	if _, err := NewWebViewAPI(a).Open(info.ID, "https://example.com/", wvBounds); err != nil {
		t.Fatalf("Open with no profile = %v", err)
	}
}

// Every method refuses a vault that is not open, and one that is private and locked.
func TestWebViewAPIRefusesAVaultThatIsNotOpenOrIsLocked(t *testing.T) {
	h := newWVHarness(t)
	api := h.api()
	id := h.open(t)
	all := func(vault string) map[string]error {
		out := map[string]error{
			"SetBounds":  api.SetBounds(vault, id, wvBounds),
			"SetVisible": api.SetVisible(vault, id, true),
			"Navigate":   api.Navigate(vault, id, "https://example.org/"),
			"Back":       api.Back(vault, id),
			"Forward":    api.Forward(vault, id),
			"Reload":     api.Reload(vault, id),
			"Focus":      api.Focus(vault, id),
			"Close":      api.Close(vault, id),
			"CloseVault": api.CloseVault(vault),
			"ClearData":  api.ClearData(vault),
		}
		_, out["Open"] = api.Open(vault, "https://example.com/", wvBounds)
		return out
	}
	calls := len(h.fake.Calls())
	for name, err := range all("0000000000000000") {
		if codeOf(err) != ErrCodeVaultNotOpen {
			t.Errorf("%s on a vault that is not open: %v", name, err)
		}
	}
	if len(h.fake.Calls()) != calls || len(h.fake.RemovedStores()) != 0 {
		t.Fatalf("the driver was called for a vault that is not open: %v", h.fake.Calls()[calls:])
	}

	// A private vault that is locked.
	cloud := h.makePrivate(t)
	for name, err := range all(h.vaultID) {
		if codeOf(err) != ErrCodeVaultLocked {
			t.Errorf("%s on a locked vault: %v", name, err)
		}
	}
	if len(h.fake.Views()) != 1 || len(h.fake.RemovedStores()) != 0 {
		t.Fatalf("a call on a locked vault changed something: %d views", len(h.fake.Views()))
	}
	// Unlocked, it works.
	h.unlock(t, cloud)
	if err := api.SetBounds(h.vaultID, id, wvBounds); err != nil {
		t.Fatalf("after the unlock: %v", err)
	}
	// ReserveKeys and Status name no vault.
	if err := api.ReserveKeys([]string{"cmd+w"}); err != nil {
		t.Fatal(err)
	}
}

// Closing a vault closes its views; the views of another vault stay.
func TestClosingTheVaultClosesItsViews(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	// A second vault.
	other, err := a.openVault(filepath.Join(t.TempDir(), "other"))
	if err != nil {
		t.Fatal(err)
	}
	mine := h.open(t)
	theirs, err := h.api().Open(other.ID, "https://example.org/", wvBounds)
	if err != nil {
		t.Fatal(err)
	}
	if err := NewVaultAPI(a).CloseVault(h.vaultID); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.fake.View(mine); ok {
		t.Fatal("the view of a closed vault is still there")
	}
	if _, ok := h.fake.View(theirs.ViewID); !ok {
		t.Fatal("the view of another vault was closed")
	}
	if err := h.api().Reload(h.vaultID, mine); codeOf(err) != ErrCodeVaultNotOpen {
		t.Fatalf("use of a view of a closed vault: %v", err)
	}
	closed := h.closed()
	if len(closed) != 1 || closed[0].(webview.ClosedPayload).Reason != webview.ClosedVaultClosed || closed[0].(webview.ClosedPayload).ViewID != mine {
		t.Fatalf("closed events %+v", closed)
	}
}

// A private vault that is locked (by hand here, by the idle timeout or a sync the same way) loses its
// views before the UI is told that the vault is locked: a native view would stay over the lock screen.
func TestLockingAPrivateVaultClosesItsViews(t *testing.T) {
	h := newWVHarness(t)
	cloud := h.makePrivate(t)
	h.unlock(t, cloud)
	id := h.open(t)
	other := h.open(t)

	if err := h.a.sync.LockVault(context.Background(), h.vaultID); err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{id, other} {
		if _, ok := h.fake.View(v); ok {
			t.Fatalf("view %s survived the lock of its vault", v)
		}
	}
	order := h.order()
	iClosed, iLocked := slices.Index(order, "webview:closed"), slices.Index(order, "vault:locked")
	if iClosed < 0 || iLocked < 0 || iClosed > iLocked {
		t.Fatalf("webview:closed must come before vault:locked: %v", order)
	}
	if closed := h.closed(); len(closed) != 2 || closed[0].(webview.ClosedPayload).Reason != webview.ClosedVaultLocked {
		t.Fatalf("closed events %+v", closed)
	}
	if _, err := h.api().Open(h.vaultID, "https://example.com/", wvBounds); codeOf(err) != ErrCodeVaultLocked {
		t.Fatalf("Open on the locked vault = %v", err)
	}
}

// A lock that happens while the platform is still making the view must not leave it behind.
func TestAViewMadeWhileTheVaultClosesIsNotLeftBehind(t *testing.T) {
	h := newWVHarness(t)
	h.a.opts.NativeViews = func() webview.Driver {
		return &closingFake{Fake: h.fake, close: func() { _ = NewVaultAPI(h.a).CloseVault(h.vaultID) }}
	}
	if _, err := h.api().Open(h.vaultID, "https://example.com/", wvBounds); err == nil {
		t.Fatal("Open succeeded on a vault that was closed meanwhile")
	}
	if n := len(h.fake.Views()); n != 0 {
		t.Fatalf("%d views left behind", n)
	}
	if n := h.a.views.m.Count(""); n != 0 {
		t.Fatalf("%d views in the table", n)
	}
}

// closingFake closes the vault in the middle of Create.
type closingFake struct {
	*webview.Fake
	close func()
}

func (c *closingFake) Create(id, u string, b webview.Bounds, ds string) error {
	c.close()
	return c.Fake.Create(id, u, b, ds)
}

func TestAppShutdownClosesEveryView(t *testing.T) {
	h := newWVHarness(t)
	h.open(t)
	h.open(t)
	h.a.Shutdown(context.Background())
	if len(h.fake.Views()) != 0 || h.fake.CloseAllCalls() != 1 {
		t.Fatalf("after Shutdown: %d views, %d CloseAll calls", len(h.fake.Views()), h.fake.CloseAllCalls())
	}
	if _, err := h.api().Open(h.vaultID, "https://example.com/", wvBounds); err == nil {
		t.Fatal("a view opened after Shutdown")
	}
	h.a.Shutdown(context.Background()) // twice is fine
}

func TestClearDataThroughTheBinding(t *testing.T) {
	h := newWVHarness(t)
	id := h.open(t)
	if err := h.api().ClearData(h.vaultID); err != nil {
		t.Fatal(err)
	}
	if store, _ := h.a.webviewStore(h.vaultID); len(h.fake.RemovedStores()) != 1 || h.fake.RemovedStores()[0] != store {
		t.Fatalf("removed %v, want the store of the vault %s", h.fake.RemovedStores(), store)
	}
	if _, ok := h.fake.View(id); ok {
		t.Fatal("the view stayed open over the data that were deleted")
	}
	if c := h.closed(); len(c) != 1 || c[0].(webview.ClosedPayload).Reason != webview.ClosedDataCleared {
		t.Fatalf("closed events %+v", c)
	}
}

// The core never opens a view by itself: starting, opening a vault, a frontend that becomes ready, a
// change of profile, reading the capabilities and the status create nothing and make no call to the driver
// that creates, loads or shows. A tab restored with the layout stays empty until the UI asks.
func TestTheCoreNeverOpensAViewByItself(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	a.DomReady(context.Background())
	refreshWith(t, a, map[string]any{"features": map[string]any{"web_viewer": true}})
	_ = (&SettingsAPI{app: a}).Capabilities()
	_, _ = h.api().Status()
	if _, err := a.openVault(filepath.Join(t.TempDir(), "second")); err != nil {
		t.Fatal(err)
	}
	for _, c := range h.fake.Calls() {
		if strings.HasPrefix(c, "create") || strings.HasPrefix(c, "navigate") || strings.HasPrefix(c, "show") {
			t.Fatalf("the driver was asked %q on its own: %v", c, h.fake.Calls())
		}
	}
	if len(h.fake.Views()) != 0 || a.views.m.Count("") != 0 {
		t.Fatal("a view exists that the UI did not ask for")
	}
}

// What the user does in a view counts as activity for the idle lock of private vaults: the pointer
// and the keys of a native view never reach the web view of the application.
func TestActivityInAViewIsActivityOfTheUser(t *testing.T) {
	h := newWVHarness(t)
	cloud := h.makePrivate(t)
	h.unlock(t, cloud)
	id := h.open(t)
	const idle = 250 * time.Millisecond
	h.a.crypto.SetLockTimeout(idle)

	// Control: with nobody working, the vault goes idle.
	time.Sleep(2 * idle)
	if !h.a.crypto.IsLocked(cloud) {
		t.Fatal("the idle timeout does not lock the vault: the test proves nothing")
	}
	h.unlock(t, cloud)
	deadline := time.Now().Add(5 * idle)
	for time.Now().Before(deadline) {
		h.fake.Emit(webview.Event{ID: id, Kind: webview.EvActivity})
		time.Sleep(idle / 5)
		if h.a.crypto.IsLocked(cloud) {
			t.Fatal("the vault went idle while the user worked in an application")
		}
	}
}

func TestEmbeddedBrowserCapabilityNeedsADriver(t *testing.T) {
	a, _, _ := newTestApp(t)
	t.Cleanup(a.shutdownWebViews)
	st := &SettingsAPI{app: a}
	if st.Capabilities().EmbeddedBrowser {
		t.Fatal("no driver, and the capability is on")
	}
	a.opts.NativeViews = func() webview.Driver { return webview.NewFake() }
	want := runtime.GOOS == "darwin" // the table: macOS only
	if got := st.Capabilities().EmbeddedBrowser; got != want {
		t.Fatalf("with a driver on %s: %v, want %v", runtime.GOOS, got, want)
	}
}

// An Open that the vault does not stop (it is still open when the Open checks) but that CloseVault's closing
// of the views did not see (it ran before the view was made) leaves a view that nothing can close any more: the
// views are closed after the vault is gone.
func TestAViewOpenedWhileTheVaultIsBeingClosedIsClosedWithIt(t *testing.T) {
	h := newWVHarness(t)
	var opened string
	testHookBeforeVaultRemoval = func() {
		testHookBeforeVaultRemoval = nil
		// The vault is still open: a whole Open goes through, between "a close was asked" and "the vault is gone".
		got, err := h.api().Open(h.vaultID, "https://example.com/", wvBounds)
		if err != nil {
			t.Errorf("Open in the window: %v", err)
		}
		opened = got.ViewID
	}
	t.Cleanup(func() { testHookBeforeVaultRemoval = nil })
	if err := NewVaultAPI(h.a).CloseVault(h.vaultID); err != nil {
		t.Fatal(err)
	}
	if opened == "" {
		t.Fatal("the hook did not run")
	}
	if _, ok := h.fake.View(opened); ok || h.a.views.m.Count("") != 0 {
		t.Fatalf("a view of a closed vault survives: %v, %d in the table", ok, h.a.views.m.Count(""))
	}
}

// The same for the lock of a private vault: an Open that checks after the key is gone closes its own view.
func TestAViewOpenedWhileThePrivateVaultLocksIsNotLeftBehind(t *testing.T) {
	h := newWVHarness(t)
	cloud := h.makePrivate(t)
	h.unlock(t, cloud)
	h.a.opts.NativeViews = func() webview.Driver {
		return &closingFake{Fake: h.fake, close: func() { _ = h.a.sync.LockVault(context.Background(), h.vaultID) }}
	}
	if _, err := h.api().Open(h.vaultID, "https://example.com/", wvBounds); err == nil {
		t.Fatal("Open succeeded on a vault that was locked meanwhile")
	}
	if len(h.fake.Views()) != 0 || h.a.views.m.Count("") != 0 {
		t.Fatalf("a view of a locked vault survives: %d, %d", len(h.fake.Views()), h.a.views.m.Count(""))
	}
}

// The flag is checked again after the view is made: a profile that turns the function off while the platform
// works must not leave a view behind (applyConfig closes the views it finds, and found none).
func TestAViewOpenedWhileTheFlagGoesOffIsNotLeftBehind(t *testing.T) {
	h := newWVHarness(t)
	// The driver is looked up inside Manager.Open, before the view is registered: the flag goes off right there.
	h.a.opts.NativeViews = func() webview.Driver {
		h.a.opts.NativeViews = func() webview.Driver { return h.fake }
		refreshWith(t, h.a, map[string]any{"features": map[string]any{"web_viewer": false}})
		return h.fake
	}
	_, err := h.api().Open(h.vaultID, "https://example.com/", wvBounds)
	if codeOf(err) != ErrCodeWebViewDisabled {
		t.Fatalf("Open = %v, want %s", err, ErrCodeWebViewDisabled)
	}
	if len(h.fake.Views()) != 0 || h.a.views.m.Count("") != 0 {
		t.Fatalf("a view survives with the function off: %d, %d", len(h.fake.Views()), h.a.views.m.Count(""))
	}
}

// The identifier of the session data is kept for the vault, is not derived from its path, and goes when the
// vault goes for good: a vault opened later at the same path does not inherit its cookies.
func TestSessionDataOfARemovedMountAreDeletedAndNotInherited(t *testing.T) {
	h := newWVHarness(t)
	a := h.a
	dir := filepath.Join(a.mountsDir(), testShareID)
	prepareMount(t, dir)
	info, err := a.openVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	first, err := h.api().Open(info.ID, "https://example.com/", wvBounds)
	if err != nil {
		t.Fatal(err)
	}
	v1, _ := h.fake.View(first.ViewID)
	if v1.DataStore == webview.DataStoreID(info.ID) {
		t.Fatal("the store is derived from the vault id (a hash of its path)")
	}
	second, _ := h.api().Open(info.ID, "https://example.org/", wvBounds)
	if v2, _ := h.fake.View(second.ViewID); v2.DataStore != v1.DataStore {
		t.Fatalf("two views of one vault have two stores: %q %q", v1.DataStore, v2.DataStore)
	}

	if _, err := NewSharingAPI(a).RemoveMount(testShareID, false); err != nil {
		t.Fatal(err)
	}
	if got := h.fake.RemovedStores(); len(got) != 1 || got[0] != v1.DataStore {
		t.Fatalf("removed %v, want %s", got, v1.DataStore)
	}
	if len(h.fake.Views()) != 0 {
		t.Fatalf("views of a removed mount survive: %d", len(h.fake.Views()))
	}
	// Another vault at the same path.
	prepareMount(t, dir)
	again, err := a.openVault(dir)
	if err != nil || again.ID != info.ID {
		t.Fatalf("the same path must give the same vault id: %v %v", again.ID, err)
	}
	third, err := h.api().Open(again.ID, "https://example.com/", wvBounds)
	if err != nil {
		t.Fatal(err)
	}
	if v3, _ := h.fake.View(third.ViewID); v3.DataStore == v1.DataStore {
		t.Fatal("a vault opened later at the same path inherits the session data of the one that was removed")
	}
}

func TestKeptCopyOfAMountDoesNotKeepItsSessions(t *testing.T) {
	h := newWVHarness(t)
	dir := filepath.Join(h.a.mountsDir(), testShareID)
	prepareMount(t, dir)
	info, err := h.a.openVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	opened, err := h.api().Open(info.ID, "https://example.com/", wvBounds)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := h.fake.View(opened.ViewID)
	if _, err := NewSharingAPI(h.a).RemoveMount(testShareID, true); err != nil {
		t.Fatal(err)
	}
	if got := h.fake.RemovedStores(); len(got) != 1 || got[0] != v.DataStore {
		t.Fatalf("removed %v, want %s", got, v.DataStore)
	}
}
