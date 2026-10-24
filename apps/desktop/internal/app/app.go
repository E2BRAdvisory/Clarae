// Package app composes the desktop backend: data directory, application
// database, open vaults (file system, index, watcher) and the bindings
// exposed to the frontend. Construction is explicit; there is no DI framework.
package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"nodus/apps/desktop/internal/auth"
	"nodus/apps/desktop/internal/config"
	"nodus/apps/desktop/internal/crypto"
	"nodus/apps/desktop/internal/indexer"
	"nodus/apps/desktop/internal/platform"
	"nodus/apps/desktop/internal/store"
	syncpkg "nodus/apps/desktop/internal/sync"
	"nodus/apps/desktop/internal/sync/transport"
	"nodus/apps/desktop/internal/vault"
	"nodus/apps/desktop/internal/watcher"
	"nodus/shared/pathrules"
)

// Options configure the application.
type Options struct {
	DataDir string
	Logger  zerolog.Logger
	Version string
	// KeyStore keeps the keys of private vaults (nil = OS keychain).
	KeyStore crypto.KeyStore
}

// App is the backend root. Bound API structs hold a pointer to it.
type App struct {
	ctx     context.Context
	opts    Options
	logger  zerolog.Logger
	appDB   *sql.DB
	auth    *auth.Service
	crypto  *crypto.Manager
	sync    *syncpkg.Manager
	config  *config.Service
	emitter func(name string, payload any) // nil = Wails runtime
	mu      sync.Mutex
	vaults  map[string]*openVault
	pending []string // nodus:// URLs received before the frontend was ready
}

// openVault is a vault currently open in this process.
type openVault struct {
	Info    VaultInfo
	FS      *vault.FS
	IndexDB *sql.DB
	Indexer *indexer.Indexer
	Watcher *watcher.Watcher
	cancel  context.CancelFunc
}

// VaultInfo is the public description of a vault.
type VaultInfo struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Path         string    `json:"path"`
	LastOpenedAt time.Time `json:"lastOpenedAt"`
}

// New prepares the application; Startup finishes initialization once Wails
// provides the context.
func New(opts Options) *App {
	a := &App{opts: opts, logger: opts.Logger, vaults: map[string]*openVault{}, config: config.New(nil)}
	a.auth = auth.New(auth.Options{
		DataDir:      opts.DataDir,
		Logger:       opts.Logger.With().Str("module", "auth").Logger(),
		AppVersion:   opts.Version,
		RedirectMode: auth.RedirectMode(os.Getenv("NODUS_AUTH_REDIRECT")), // "" = auto; "scheme" forces the fallback (checklist)
		OpenURL: func(u string) error {
			if a.ctx == nil {
				return errors.New("application not ready")
			}
			runtime.BrowserOpenURL(a.ctx, u)
			return nil
		},
		OnState: func(st auth.State) {
			a.emit(EventAuthState, st)
			a.sync.SessionChanged()
			if st.Status == auth.StatusReady {
				go a.onSignedIn()
			}
		},
	})
	a.crypto = crypto.NewManager(crypto.Options{Store: opts.KeyStore})
	a.sync = syncpkg.NewManager(sessionAdapter{a}, a.crypto, opts.Logger.With().Str("module", "sync").Logger(), a.emit)
	a.sync.SetHooks(syncpkg.Hooks{
		Shares:        func(transport.ShareEvent) { go a.reconcileMounts() },
		Config:        func(int) { go a.refreshConfigQuietly() },
		ConfigVersion: func() int { return a.config.Version() },
	})
	return a
}

// sessionAdapter lets the sync manager use the cloud login.
type sessionAdapter struct{ a *App }

func (s sessionAdapter) Client() *transport.Client { return s.a.auth.Client() }

func (s sessionAdapter) Info() (syncpkg.SessionInfo, bool) {
	st := s.a.auth.State()
	if st.Status != auth.StatusReady && st.Status != auth.StatusDisconnected {
		return syncpkg.SessionInfo{}, false
	}
	return syncpkg.SessionInfo{
		ServerURL: st.ServerURL, DeviceID: st.DeviceID, UserID: st.Profile.UserID,
		DeviceName: s.a.auth.DeviceName(), GRPCEndpoint: s.a.auth.GRPCEndpoint(),
	}, true
}

// Startup is the Wails OnStartup hook.
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	db, err := store.Open(ctx, filepath.Join(a.opts.DataDir, "app.db"), store.KindApp)
	if err != nil {
		a.logger.Error().Err(err).Msg("open app.db")
		_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{Type: runtime.ErrorDialog, Title: "Nodus", Message: "Cannot open the application database: " + err.Error()})
		return
	}
	a.appDB = db
	a.config = config.New(db)
	if st := a.auth.State(); st.ServerURL != "" {
		a.config.Load(ctx, st.ServerURL) // the last valid configuration applies from the first moment, offline included
		a.applyConfig()
	}
	a.sync.Start(ctx)
	a.auth.Restore(ctx)
	a.logger.Info().Str("version", a.opts.Version).Str("data_dir", a.opts.DataDir).Msg("started")
}

// DomReady is the Wails OnDomReady hook: the frontend can receive events.
func (a *App) DomReady(_ context.Context) {
	a.mu.Lock()
	pending := a.pending
	a.pending = nil
	a.mu.Unlock()
	for _, u := range pending {
		a.HandleURL(u)
	}
}

// Shutdown is the Wails OnShutdown hook.
func (a *App) Shutdown(_ context.Context) {
	a.sync.Shutdown()
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, v := range a.vaults {
		a.closeVaultLocked(id, v)
	}
	if a.appDB != nil {
		_ = a.appDB.Close()
	}
	a.logger.Info().Msg("stopped")
}

// OnSecondInstance is the Wails single-instance callback: another instance
// was launched with these arguments (Windows/Linux deliver nodus:// URLs
// this way). The running window is brought to the front.
func (a *App) OnSecondInstance(data options.SecondInstanceData) {
	a.logger.Info().Strs("args", data.Args).Msg("second instance launch")
	if a.ctx != nil {
		runtime.WindowUnminimise(a.ctx)
		runtime.Show(a.ctx)
	}
	if u, ok := platform.FindSchemeURL(data.Args); ok {
		a.HandleURL(u)
	}
}

// HandleURL processes a nodus:// URL (macOS OnUrlOpen, second instance
// arguments, or the login flow's custom-scheme fallback).
func (a *App) HandleURL(raw string) {
	u, err := platform.ParseSchemeURL(raw)
	if err != nil {
		a.logger.Warn().Err(err).Str("url", raw).Msg("ignored url")
		return
	}
	if a.ctx == nil {
		a.mu.Lock()
		a.pending = append(a.pending, raw)
		a.mu.Unlock()
		return
	}
	switch u.Kind {
	case platform.URLOpen:
		a.emit(EventOpenRequest, OpenRequestPayload{Vault: u.Params.Get("vault"), File: u.Params.Get("file")})
	case platform.URLAuthCallback:
		if !a.auth.HandleCallback(u.Params) {
			a.logger.Warn().Msg("auth callback received with no login in progress")
		}
	case platform.URLAuthLogout:
		a.logger.Info().Msg("logout redirect received")
	}
}

// --- vault lifecycle ------------------------------------------------------

// ErrVaultNotOpen is returned by bindings for unknown vault ids.
var ErrVaultNotOpen = errors.New("vault is not open")

func vaultID(path string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(path)))
	return hex.EncodeToString(sum[:8])
}

func (a *App) vault(id string) (*openVault, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	v, ok := a.vaults[id]
	if !ok {
		return nil, ErrVaultNotOpen
	}
	return v, nil
}

// openVault opens (or returns the already open) vault at path.
func (a *App) openVault(path string) (VaultInfo, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return VaultInfo{}, err
	}
	id := vaultID(abs)
	a.mu.Lock()
	if v, ok := a.vaults[id]; ok {
		a.mu.Unlock()
		return v.Info, nil
	}
	a.mu.Unlock()

	if err := os.MkdirAll(abs, 0o755); err != nil {
		return VaultInfo{}, err
	}
	fsys, err := vault.NewFS(abs)
	if err != nil {
		return VaultInfo{}, err
	}
	indexPath := filepath.Join(fsys.Root(), pathrules.ConfigDir, "index.db")
	indexDB, err := store.Open(a.ctx, indexPath, store.KindIndex)
	if err != nil {
		return VaultInfo{}, err
	}
	info := VaultInfo{ID: id, Name: filepath.Base(abs), Path: abs, LastOpenedAt: time.Now()}
	if mm, ok, _ := syncpkg.ReadMount(a.ctx, abs); ok && mm.Name != "" {
		info.Name = mm.Name // a mount lives in a folder named by the share id: show the share's name
	}
	log := a.logger.With().Str("vault", info.Name).Logger()
	ix := indexer.New(fsys, indexDB, log, func(p indexer.Progress) {
		a.emit(EventIndexProgress, map[string]any{"vaultId": id, "done": p.Done, "total": p.Total, "path": p.Path, "finished": p.Finished})
	})
	ctx, cancel := context.WithCancel(a.ctx)
	w, err := watcher.New(ctx, fsys.Root(), watcher.Options{Logger: log})
	if err != nil {
		cancel()
		_ = indexDB.Close()
		return VaultInfo{}, err
	}
	v := &openVault{Info: info, FS: fsys, IndexDB: indexDB, Indexer: ix, Watcher: w, cancel: cancel}
	a.mu.Lock()
	a.vaults[id] = v
	a.mu.Unlock()

	if err := a.rememberVault(info); err != nil {
		log.Warn().Err(err).Msg("remember vault")
	}
	if err := a.sync.Attach(ctx, id, fsys); err != nil {
		log.Warn().Err(err).Msg("sync state unavailable")
	}
	go func() {
		if err := ix.Full(ctx); err != nil {
			log.Error().Err(err).Msg("initial index")
		}
	}()
	go a.watchLoop(ctx, v)
	return info, nil
}

func (a *App) watchLoop(ctx context.Context, v *openVault) {
	for {
		select {
		case <-ctx.Done():
			return
		case ch, ok := <-v.Watcher.C():
			if !ok {
				return
			}
			if ch.Reconcile {
				if err := v.Indexer.Full(ctx); err != nil {
					a.logger.Warn().Err(err).Msg("reconcile")
				}
				a.sync.Kick(v.Info.ID)
				continue
			}
			if err := v.Indexer.Update(ctx, ch.Paths); err != nil {
				a.logger.Warn().Err(err).Msg("index update")
			}
			a.emit(EventVaultFileChanged, FileChangedPayload{VaultID: v.Info.ID, Paths: ch.Paths})
			a.sync.Kick(v.Info.ID)
		}
	}
}

func (a *App) closeVaultLocked(id string, v *openVault) {
	a.sync.Detach(id)
	v.cancel()
	_ = v.Watcher.Close()
	_ = v.IndexDB.Close()
	delete(a.vaults, id)
}

func (a *App) rememberVault(info VaultInfo) error {
	if a.appDB == nil {
		return nil
	}
	_, err := a.appDB.ExecContext(a.ctx, `
		INSERT INTO recent_vaults (path, name, last_opened_at) VALUES (?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at`,
		info.Path, info.Name, info.LastOpenedAt.UTC().Format(time.RFC3339))
	return err
}

func (a *App) recentVaults() ([]VaultInfo, error) {
	if a.appDB == nil {
		return []VaultInfo{}, nil
	}
	rows, err := a.appDB.QueryContext(a.ctx, `SELECT path, name, last_opened_at FROM recent_vaults ORDER BY last_opened_at DESC LIMIT 20`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []VaultInfo{}
	for rows.Next() {
		var v VaultInfo
		var ts string
		if err := rows.Scan(&v.Path, &v.Name, &ts); err != nil {
			return nil, err
		}
		v.ID = vaultID(v.Path)
		v.LastOpenedAt, _ = time.Parse(time.RFC3339, ts)
		out = append(out, v)
	}
	return out, rows.Err()
}
