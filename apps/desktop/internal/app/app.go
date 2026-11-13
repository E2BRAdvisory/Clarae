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
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/auth"
	"clarae/apps/desktop/internal/config"
	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/history"
	"clarae/apps/desktop/internal/indexer"
	"clarae/apps/desktop/internal/platform"
	"clarae/apps/desktop/internal/search"
	"clarae/apps/desktop/internal/store"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/apps/desktop/internal/vault"
	"clarae/apps/desktop/internal/watcher"
	"clarae/shared/pathrules"
)

// Options configure the application.
type Options struct {
	DataDir string
	Logger  zerolog.Logger
	Version string
	// LegacyDataDir is the data directory of 1.x next to DataDir ("" = none, or DataDir was asked
	// for explicitly). What the application database remembers inside it was moved with it, and
	// Startup points it at DataDir (ADR-0052).
	LegacyDataDir string
	// KeyStore keeps the keys of private vaults (nil = OS keychain).
	KeyStore crypto.KeyStore
	// Host connects the application to its environment: the Wails window of internal/shell on the
	// desktop, the page in the browser (nil = no window, host_native.go).
	Host Host
}

// App is the backend root. Bound API structs hold a pointer to it.
type App struct {
	ctx       context.Context
	opts      Options
	host      Host
	logger    zerolog.Logger
	appDB     *sql.DB
	auth      *auth.Service
	crypto    *crypto.Manager
	sync      *syncpkg.Manager
	config    *config.Service
	emitter   func(name string, payload any) // nil = the host
	emitterMu sync.RWMutex                   // guards emitter (tests swap it while indexing runs)
	mu        sync.Mutex
	vaults    map[string]*openVault
	opening   map[string]*vaultOpening // opens in progress, by vault id (guarded by mu)
	pending   []string                 // clarae:// URLs received before the frontend was ready (guarded by mu)
	ready     bool                     // the frontend can receive events: DomReady was called (guarded by mu)
	updates   updaterState             // the update channel (none in the browser build)
	ai        aiState                  // the writing assistant (inactive; none in the browser build)
	// reconciler runs the reconciles of the mounts one at a time (requestReconcile).
	reconciler coalescer
}

// openVault is a vault currently open in this process.
type openVault struct {
	Info    VaultInfo
	FS      *vault.FS
	IndexDB *sql.DB
	Indexer *indexer.Indexer
	Watcher *watcher.Watcher
	History *history.History
	cancel  context.CancelFunc
}

// vaultOpening is an open in progress: concurrent opens of the same vault wait
// for it and share its result instead of building a second indexer, watcher
// and history that nobody would ever close.
type vaultOpening struct {
	done chan struct{}
	info VaultInfo
	err  error
}

// VaultInfo is the public description of a vault.
type VaultInfo struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Path         string    `json:"path"`
	LastOpenedAt time.Time `json:"lastOpenedAt"`
}

// New prepares the application; Startup finishes initialization once the shell
// provides the context.
func New(opts Options) *App {
	if opts.Host == nil {
		opts.Host = defaultHost()
	}
	var hosted *auth.Hosted
	if sh, ok := opts.Host.(SessionHost); ok {
		hosted = sh.Session()
		if opts.KeyStore == nil {
			opts.KeyStore = crypto.NewMemoryStore() // no OS keychain in a browser: the VMK lives in memory
		}
	}
	a := &App{opts: opts, host: opts.Host, logger: opts.Logger, vaults: map[string]*openVault{}, config: config.New(nil)}
	setBindingLogger(opts.Logger)
	a.auth = auth.New(auth.Options{
		Hosted:       hosted,
		DataDir:      opts.DataDir,
		Logger:       opts.Logger.With().Str("module", "auth").Logger(),
		AppVersion:   opts.Version,
		RedirectMode: envRedirectMode(opts.Logger), // "" = from the Config Profile, else auto; "scheme" forces the fallback (checklist)
		OpenURL: func(u string) error {
			ctx := a.appContext()
			if ctx == nil {
				return errors.New("application not ready")
			}
			a.host.OpenURL(ctx, u)
			return nil
		},
		OnState: func(st auth.State) {
			EventAuthState.Send(a.emit, st)
			a.sync.SessionChanged()
			if st.Status == auth.StatusReady {
				go a.onSignedIn()
			}
		},
	})
	a.crypto = crypto.NewManager(crypto.Options{Store: opts.KeyStore})
	a.sync = syncpkg.NewManager(sessionAdapter{a}, a.crypto, opts.Logger.With().Str("module", "sync").Logger(), a.emit)
	a.sync.SetHooks(syncpkg.Hooks{
		Shares:          func(transport.ShareEvent) { a.requestReconcile() },
		Config:          func(int) { go a.refreshConfigQuietly() },
		ConfigVersion:   func() int { return a.config.Version() },
		BeforeOverwrite: a.snapshotBeforeOverwrite,
		// The cloud refused this device: the session says so (auth:state device_revoked) and the
		// workbench offers to register the device again.
		DeviceRevoked: a.auth.DeviceRevoked,
	})
	return a
}

// sessionAdapter lets the sync manager use the cloud login.
type sessionAdapter struct{ a *App }

func (s sessionAdapter) Client() *transport.Client { return s.a.auth.Client() }

func (s sessionAdapter) Info() (syncpkg.SessionInfo, bool) {
	st := s.a.auth.State()
	if st.Status == auth.StatusDeviceRevoked {
		// Signed in, but nothing may sync until the device is registered again.
		return syncpkg.SessionInfo{ServerURL: st.ServerURL, DeviceID: st.DeviceID, UserID: st.Profile.UserID, DeviceRevoked: true}, false
	}
	if st.Status != auth.StatusReady && st.Status != auth.StatusDisconnected {
		return syncpkg.SessionInfo{}, false
	}
	return syncpkg.SessionInfo{
		ServerURL: st.ServerURL, DeviceID: st.DeviceID, UserID: st.Profile.UserID,
		DeviceName: s.a.auth.DeviceName(), GRPCEndpoint: s.a.auth.GRPCEndpoint(),
	}, true
}

// Startup finishes the initialization with the context of the application (the desktop shell calls it from the start of its bridge service, shell.Lifecycle).
func (a *App) Startup(ctx context.Context) {
	a.mu.Lock()
	a.ctx = ctx
	a.mu.Unlock()
	db, err := store.Open(ctx, filepath.Join(a.opts.DataDir, "app.db"), store.KindApp)
	if err != nil {
		a.logger.Error().Err(err).Msg("open app.db")
		a.host.ErrorDialog(ctx, "Clarae notanda", "Cannot open the application database: "+err.Error())
		return
	}
	a.appDB = db
	a.adoptLegacyDataDir(ctx)
	a.config = config.New(db)
	if st := a.auth.State(); st.ServerURL != "" {
		a.config.Load(ctx, st.ServerURL) // the last valid configuration applies from the first moment, offline included
		a.applyConfig()
	} else {
		a.applyLockTimeout() // the user's own choice applies without a server
	}
	a.sync.Start(ctx)
	a.auth.Restore(ctx)
	a.startUpdater(ctx)
	a.logger.Info().Str("version", a.opts.Version).Str("data_dir", a.opts.DataDir).Msg("started")
}

// appContext is the context given to Startup, nil before it; Startup and the shell hooks that
// need it (second instance, auth) run on different goroutines.
func (a *App) appContext() context.Context {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ctx
}

// DomReady is the explicit "frontend ready" signal: the shell calls it when the frontend can
// receive events (the frontend shim through CoreBridge.DomReady; the page in the browser). clarae:// URLs that
// arrived earlier, whatever the state of the context, are delivered now, in order, and the ones
// that follow are handled at once.
func (a *App) DomReady(_ context.Context) {
	a.mu.Lock()
	a.ready = true
	pending := a.pending
	a.pending = nil
	a.mu.Unlock()
	for _, u := range pending {
		a.HandleURL(u)
	}
}

// Shutdown releases what Startup and the open vaults hold (the desktop shell calls it from shell.Lifecycle.Stop). It is
// idempotent: the shell may call it from more than one place.
func (a *App) Shutdown(_ context.Context) {
	a.shutdownAI()
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

// HandleURL processes a clarae:// URL (macOS ApplicationLaunchedWithUrl, second instance
// arguments, or the login flow's custom-scheme fallback). Until DomReady the URL is queued: the
// frontend could not receive the event, and an auth callback needs the login the frontend started.
func (a *App) HandleURL(raw string) {
	u, err := platform.ParseSchemeURL(raw)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // url.Error repeats the whole URL, query included
		}
		a.logger.Warn().Err(err).Str("url", redactURL(raw)).Msg("ignored url")
		return
	}
	a.mu.Lock()
	if !a.ready {
		a.pending = append(a.pending, raw)
		a.mu.Unlock()
		return
	}
	a.mu.Unlock()
	switch u.Kind {
	case platform.URLOpen:
		EventOpenRequest.Send(a.emit, OpenRequestPayload{Vault: u.Params.Get("vault"), File: u.Params.Get("file")})
	case platform.URLAuthCallback:
		if !a.auth.HandleCallback(u.Params) {
			a.logger.Warn().Msg("auth callback received with no login in progress")
		}
	case platform.URLAuthLogout:
		a.logger.Info().Msg("logout redirect received")
	}
}

// OnSecondInstance handles another instance launched with these arguments (the single-instance
// callback of the shell; Windows and Linux deliver clarae:// URLs this way). The running window
// is brought to the front; the arguments may be the whole command line, the first URL is the one
// handled.
func (a *App) OnSecondInstance(args []string) {
	a.logger.Info().Strs("args", redactArgs(args)).Msg("second instance launch")
	if ctx := a.appContext(); ctx != nil {
		a.host.ShowWindow(ctx)
	}
	if u, ok := platform.FindSchemeURL(args); ok {
		a.HandleURL(u)
	}
}

// redactURL drops the query and fragment of a URL before it is logged: an
// auth callback carries the authorization code and the state, and the logs
// end up in support bundles. Anything that does not parse is replaced.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return "[redacted]"
	}
	out := u.Scheme + "://" + u.Host + u.EscapedPath()
	if u.Opaque != "" {
		out = u.Scheme + ":[opaque]"
	}
	if u.RawQuery != "" || u.Fragment != "" {
		out += "?[redacted]"
	}
	return out
}

// redactArgs is the argv of a second instance as it may be logged: URLs
// without their query, other arguments only counted (they can be paths).
func redactArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for _, a := range args {
		if strings.Contains(a, "://") {
			out = append(out, redactURL(a))
		} else {
			out = append(out, "[arg]")
		}
	}
	return out
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

// openVault opens (or returns the already open) vault at path. Concurrent
// calls for the same vault share one open; a failed open leaves nothing
// behind, so a later call tries again.
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
	if op, ok := a.opening[id]; ok {
		a.mu.Unlock()
		<-op.done
		return op.info, op.err
	}
	op := &vaultOpening{done: make(chan struct{})}
	if a.opening == nil {
		a.opening = map[string]*vaultOpening{}
	}
	a.opening[id] = op
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.opening, id)
		a.mu.Unlock()
		close(op.done)
	}()
	op.info, op.err = a.doOpenVault(abs, id)
	return op.info, op.err
}

// testHookOpenVault runs at the start of every actual open (tests).
var testHookOpenVault func()

// doOpenVault builds and registers an open vault; openVault makes sure only
// one call per id runs at a time.
func (a *App) doOpenVault(abs, id string) (VaultInfo, error) {
	if testHookOpenVault != nil {
		testHookOpenVault()
	}
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
	if isWeb && info.Name == filepath.Base(abs) {
		// A browser names its folders by cloud vault id; once linked, show the name the user gave the vault.
		if n := syncpkg.ReadVaultName(a.ctx, abs); n != "" {
			info.Name = n
		}
	}
	log := a.logger.With().Str("vault", info.Name).Logger()
	ix := indexer.New(fsys, indexDB, log, func(p indexer.Progress) {
		EventIndexProgress.Send(a.emit, IndexProgressPayload{VaultID: id, Done: p.Done, Total: p.Total, Path: p.Path, Finished: p.Finished})
	})
	ctx, cancel := context.WithCancel(a.ctx)
	w, err := watcher.New(ctx, fsys.Root(), watcher.Options{Logger: log})
	if err != nil {
		cancel()
		_ = indexDB.Close()
		return VaultInfo{}, err
	}
	if isWeb {
		fsys.SetOnChange(w.Notify) // no fsnotify here: the core's own writes are the only changes
	}
	hist := history.New(history.Options{
		FS: fsys, Logger: log,
		ReadOnly: func() bool { return a.sync.ReadOnly(context.Background(), id) },
	})
	hist.Start(ctx)
	v := &openVault{Info: info, FS: fsys, IndexDB: indexDB, Indexer: ix, Watcher: w, History: hist, cancel: cancel}
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
		// Load the search candidate cache now so the first search is fast.
		if err := search.New(indexDB).Warm(ctx); err != nil && ctx.Err() == nil {
			log.Warn().Err(err).Msg("search cache warm-up")
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
				a.reconcile(ctx, v)
				continue
			}
			changes := classifyChanges(ctx, v, ch.Paths) // before the index learns of the batch
			if err := v.Indexer.Update(ctx, ch.Paths); err != nil {
				a.logger.Warn().Err(err).Msg("index update")
			}
			v.History.Observe(ch.Paths)
			EventVaultFileChanged.Send(a.emit, FileChangedPayload{VaultID: v.Info.ID, Paths: ch.Paths, Changes: changes})
			a.sync.Kick(v.Info.ID)
		}
	}
}

// reconcile compares the whole vault with the index (the periodic pass, or events were lost).
// What it finds changed reaches the frontend and the history like a watcher batch: otherwise a
// file changed while events were lost would stay stale in the file tree and in an open editor,
// and would have no snapshot.
func (a *App) reconcile(ctx context.Context, v *openVault) {
	r, err := v.Indexer.Reconcile(ctx)
	if err != nil {
		a.logger.Warn().Err(err).Msg("reconcile")
	}
	if !r.Empty() { // after an error too: what the pass wrote before it is in the index
		paths, changes := reconciledChanges(v, r)
		v.History.Observe(paths)
		EventVaultFileChanged.Send(a.emit, FileChangedPayload{VaultID: v.Info.ID, Paths: paths, Changes: changes})
	}
	a.sync.Kick(v.Info.ID)
}

func (a *App) closeVaultLocked(id string, v *openVault) {
	a.sync.Detach(id)
	v.cancel()
	v.History.Close()
	_ = v.Watcher.Close()
	search.Forget(v.IndexDB)
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
