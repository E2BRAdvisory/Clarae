//go:build !js

package app

// The sweep of the session data of the applications of vaults that no longer exist.
//
// Every vault has a data store for its applications (cookies, local storage, caches), named by a
// random identifier kept in app.db under webview_store:<vault id>. forgetWebViewData drops it when
// the application itself ends a vault for good (a mount that is removed). A vault can also go
// without the application being told: the folder is deleted in the file manager, the vault never
// comes back at that path. Its store would stay for ever. The sweep, run in the background after
// the start, finds those and deletes them.
//
// What "a vault that no longer exists" means. The id of a vault is a hash of its path, so the only
// way to tell whether the vault of an entry exists is to ask where the application knows vaults from.
// An entry is dropped when its vault id is none of these:
//
//  1. a vault that is open, or being opened, now;
//  2. a folder in the mounts directory of the application (a share mounted on this device, whether it
//     is open, closed, read-only or revoked: while the folder is there the vault exists);
//  3. a row of recent_vaults (all of them, not only the twenty the UI lists) that is not provably gone.
//
// A recent vault is provably gone only when all of this holds:
//
//   - it was last opened more than webviewStoreGrace ago (a folder that is moved aside for a while,
//     a cloud-storage placeholder that is not there yet, a rename about to be undone, all come back
//     within the period);
//   - its path is not on a volume that can be taken away: a drive other than the system drive or a
//     network share on Windows, /Volumes, /media, /mnt, /run/media and the like elsewhere. A folder
//     on an external disk that is not plugged in is missing too, and looks exactly like a deleted
//     one: it is never judged;
//   - looking at the folder gives "does not exist" (not "permission denied", not an input/output
//     error, not a timeout) while the folder that contains it is there, can be read AND IS NOT EMPTY:
//     the volume is mounted and the folder itself is missing, not a whole tree that a mount point or a
//     network drive would have taken with it. An empty parent is the signature of a mount point whose
//     file system is not mounted (a user's choice such as ~/GDrive/Notes with rclone, sshfs or macFUSE,
//     ~/Cryptomator/Vault/Notes): the vault is not deleted, it is away.
//
// Known limit: the empty-parent test is a signature, not a proof. A vault that was the only content
// of its folder, deleted, leaves that folder empty and is kept (a few megabytes of cookies; deleting
// the data of a vault that is only away would lose what the user may have in them). The stronger test,
// recording the device number (st_dev) of the folder of each vault when it is opened and calling it
// gone only if the parent has the same device today, needs a column in app.db and a file per platform
// (no st_dev on Windows or in the browser), so it is not done.
//
// Anything else keeps the entry: not being open at the moment is never a reason (a vault that is not
// open is the normal case), and the cost of keeping a store of a vault that is gone is a few megabytes
// of cookies, while a wrong deletion logs the person out of the sites of the applications of a vault
// that exists.
//
// An entry whose vault id appears nowhere (not even as a recent vault) is dropped without the
// period: nothing can lead to it any more (the recent vaults of a data directory that moved
// are rewritten at another path, so another id).
//
// The data of the platform go first and the entry after them: if the platform fails (or has no answer
// in time) the entry stays and the next start tries again. Where no driver exists at all (the platform
// has none) only the entries go: there is nothing else.

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"clarae/apps/desktop/internal/webview"
)

const (
	// webviewStoreGrace is how long a recent vault whose folder is missing is believed to come back.
	webviewStoreGrace = 30 * 24 * time.Hour
	// webviewDriverWait is how long the sweep waits for the window of the application, and with it the
	// driver, to exist. Past it the sweep does nothing until the next start.
	webviewDriverWait = 2 * time.Minute
)

// webviewStorePrefix starts the key of every entry (see webviewStoreKey).
const webviewStorePrefix = "webview_store:"

// startWebViewSweep runs the sweep in the background: opening a vault never waits for it.
func (a *App) startWebViewSweep(ctx context.Context) {
	go func() {
		if !a.waitWebViewDriver(ctx) {
			return
		}
		n, err := a.sweepWebViewStores(ctx, time.Now())
		switch {
		case err != nil && ctx.Err() == nil:
			a.logger.Warn().Err(err).Msg("sweep of the session data of the applications of vaults that no longer exist")
		case n > 0:
			a.logger.Info().Int("stores", n).Msg("session data of the applications of vaults that no longer exist were deleted")
		}
	}()
}

// webviewDriverExpected says whether this process may get a driver: it has a way to ask for one, and
// the host does not say that its build has none.
func (a *App) webviewDriverExpected() bool {
	if a.opts.NativeViews != nil {
		return true
	}
	h, ok := a.host.(NativeViewHost)
	if !ok {
		return false
	}
	if s, ok := h.(NativeViewsSupport); ok {
		return s.NativeViewsSupported()
	}
	return true
}

// waitWebViewDriver returns once the sweep can tell what it may do: a driver exists, or none is
// expected (the entries alone are swept). It returns false when the window did not come in time or the
// application is quitting.
func (a *App) waitWebViewDriver(ctx context.Context) bool {
	if a.views.m.Available() || !a.webviewDriverExpected() {
		return true
	}
	deadline := time.NewTimer(webviewDriverWait)
	defer deadline.Stop()
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return false
		case <-tick.C:
			if a.views.m.Available() {
				return true
			}
		}
	}
}

type webviewStoreEntry struct{ vaultID, store string }

// sweepWebViewStores deletes the entries (and the data) of the vaults that no longer exist, by the rule
// above, and returns how many entries it dropped. now is the clock (replaced in tests).
func (a *App) sweepWebViewStores(ctx context.Context, now time.Time) (int, error) {
	if a.appDB == nil {
		return 0, nil
	}
	// The entries come first, the sets of known vaults after them: a vault opened in between, with an
	// entry created in between, is then in the second but not in the first, never the other way round.
	entries, err := a.webviewStoreEntries(ctx)
	if err != nil || len(entries) == 0 {
		return 0, err
	}
	known, err := a.knownVaultsAmong(ctx, entries, now)
	if err != nil {
		return 0, err
	}
	hasDriver := a.views.m.Available()
	if !hasDriver && a.webviewDriverExpected() {
		return 0, nil // the platform can hold data, and cannot be asked yet: next time
	}
	dropped := 0
	for _, e := range entries {
		if ctx.Err() != nil {
			return dropped, ctx.Err()
		}
		if known[e.vaultID] {
			continue
		}
		if testHookSweepBeforeRemove != nil {
			testHookSweepBeforeRemove(e.vaultID)
		}
		// The sets of known vaults are a photograph: the vault may have been opened since (the user
		// recreated the folder and opened it). Looked at again just before the deletion, which leaves a
		// window of a few instructions, not the length of the sweep.
		if a.vaultInUse(e.vaultID) {
			continue
		}
		if hasDriver {
			if _, perr := uuid.Parse(e.store); perr == nil { // anything else was never an identifier of the platform
				if err := a.views.m.RemoveStore(e.store); err != nil {
					if errors.Is(err, webview.ErrUnavailable) {
						return dropped, nil
					}
					a.logger.Warn().Err(err).Str("vault", e.vaultID).Msg("the session data of the applications of a vault that no longer exists could not be deleted: kept for the next start")
					continue
				}
			}
		}
		// Only the entry that was read: another value would be a store made since.
		if _, err := a.appDB.ExecContext(ctx, `DELETE FROM app_settings WHERE key = ? AND value = ?`, webviewStoreKey(e.vaultID), e.store); err != nil {
			return dropped, err
		}
		dropped++
	}
	return dropped, nil
}

// testHookSweepBeforeRemove runs for each orphan, before the last check (tests).
var testHookSweepBeforeRemove func(vaultID string)

// vaultInUse reports whether the vault is open, being opened, or has a view now.
func (a *App) vaultInUse(id string) bool {
	a.mu.Lock()
	_, open := a.vaults[id]
	_, opening := a.opening[id]
	a.mu.Unlock()
	return open || opening || a.views.m.Count(id) > 0
}

// webviewStoreEntries lists the entries of app_settings.
func (a *App) webviewStoreEntries(ctx context.Context) ([]webviewStoreEntry, error) {
	rows, err := a.appDB.QueryContext(ctx, `SELECT key, value FROM app_settings WHERE key GLOB 'webview_store:*'`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []webviewStoreEntry
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		if id := strings.TrimPrefix(key, webviewStorePrefix); id != "" {
			out = append(out, webviewStoreEntry{vaultID: id, store: value})
		}
	}
	return out, rows.Err()
}

// knownVaultsAmong returns, for the vault ids of the entries, whether the vault exists (see the rule
// at the top of the file). Only those are looked at on disk: the folder of a vault that has no entry
// is not worth a call to a file system that may be slow.
func (a *App) knownVaultsAmong(ctx context.Context, entries []webviewStoreEntry, now time.Time) (map[string]bool, error) {
	known := make(map[string]bool, len(entries))
	want := make(map[string]bool, len(entries))
	for _, e := range entries {
		want[e.vaultID] = true
	}
	a.mu.Lock()
	for id := range a.vaults {
		known[id] = true
	}
	for id := range a.opening {
		known[id] = true
	}
	a.mu.Unlock()

	// Mounts: a folder in the mounts directory is a vault that exists. A mounts directory that cannot
	// be read says nothing: the sweep stops instead of judging.
	if a.opts.DataDir != "" {
		dir := a.mountsDir()
		des, err := os.ReadDir(dir)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		for _, de := range des {
			if abs, err := filepath.Abs(filepath.Join(dir, de.Name())); err == nil {
				known[vaultID(abs)] = true
			}
		}
	}

	// Recent vaults, all of them.
	rows, err := a.appDB.QueryContext(ctx, `SELECT path, last_opened_at FROM recent_vaults`)
	if err != nil {
		return nil, err
	}
	type recent struct{ path, last string }
	var recents []recent
	for rows.Next() {
		var r recent
		if err := rows.Scan(&r.path, &r.last); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if id := vaultID(r.path); want[id] && !known[id] {
			recents = append(recents, r)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, r := range recents {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if id := vaultID(r.path); !known[id] && !recentVaultGone(r.path, r.last, now) {
			known[id] = true
		}
	}
	return known, nil
}

// recentVaultGone applies the rule for a row of recent_vaults: true only when the folder is provably
// gone and not just away.
func recentVaultGone(path, lastOpened string, now time.Time) bool {
	last, err := time.Parse(time.RFC3339, lastOpened)
	if err != nil || now.Sub(last) < webviewStoreGrace {
		return false // no date, or recent (or from the future): not judged
	}
	if onRemovableVolume(path) {
		return false
	}
	if _, err := os.Lstat(path); !errors.Is(err, fs.ErrNotExist) {
		return false // there, or not answering as "missing"
	}
	// The folder that holds it must be there to be read, and have something else in it: an empty folder
	// is what a mount point looks like while nothing is mounted on it.
	return parentHasContent(filepath.Dir(path))
}

// parentHasContent reports whether dir is a readable folder with at least one entry.
func parentHasContent(dir string) bool {
	f, err := os.Open(dir)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	if st, err := f.Stat(); err != nil || !st.IsDir() {
		return false
	}
	names, err := f.Readdirnames(1)
	return err == nil && len(names) > 0
}

// onRemovableVolume reports whether a path lies where a disk or a share that can be unplugged,
// unmounted or disconnected is mounted. The test is on the path as written, not on the file system:
// an unmounted volume leaves nothing to ask. Windows: any volume but the system drive, UNC shares
// included. Elsewhere the usual mount roots.
func onRemovableVolume(path string) bool {
	if vol := filepath.VolumeName(path); vol != "" {
		sys := os.Getenv("SystemDrive")
		if sys == "" {
			sys = "C:"
		}
		return !strings.EqualFold(vol, sys)
	}
	slash := filepath.ToSlash(path)
	for _, root := range []string{"/Volumes/", "/media/", "/mnt/", "/run/media/", "/net/", "/nfs/", "/Network/", "/afs/"} {
		if strings.HasPrefix(slash, root) {
			return true
		}
	}
	return false
}
