package sync

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"path/filepath"
	stdsync "sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"nodus/apps/desktop/internal/crypto"
	"nodus/apps/desktop/internal/store"
	"nodus/apps/desktop/internal/sync/transport"
	"nodus/apps/desktop/internal/vault"
	"nodus/shared/pathrules"
	"nodus/shared/syncproto"
)

// SessionInfo describes the signed-in account.
type SessionInfo struct {
	ServerURL    string
	DeviceID     string
	UserID       string
	DeviceName   string
	GRPCEndpoint string
}

// Session is the cloud login as the manager sees it (implemented over auth.Service).
type Session interface {
	// Client returns an API client, or nil when signed out.
	Client() *transport.Client
	Info() (SessionInfo, bool)
}

// Event names pushed to the UI.
const (
	EventStatus   = "sync:status"
	EventConflict = "sync:conflict"
	EventLocked   = "vault:locked"
)

// Manager owns the sync engines of the open vaults and the realtime stream.
type Manager struct {
	session Session
	crypto  *crypto.Manager
	log     zerolog.Logger
	emit    func(name string, payload any)

	mu       stdsync.Mutex
	vaults   map[string]*managed // keyed by local vault id
	notifier context.CancelFunc
	appCtx   context.Context
	streamUp atomic.Bool
}

type managed struct {
	localID string
	fs      *vault.FS
	sdb     *sql.DB
	db      *DB

	engine  *Engine
	cloudID string
	kind    string
	cancel  context.CancelFunc
	kick    chan struct{}
	now     chan struct{} // immediate sync request (skips the debounce)
	running bool
}

// NewManager creates the manager; emit publishes UI events (may be a no-op).
func NewManager(session Session, cm *crypto.Manager, log zerolog.Logger, emit func(string, any)) *Manager {
	if emit == nil {
		emit = func(string, any) {}
	}
	return &Manager{session: session, crypto: cm, log: log, emit: emit, vaults: map[string]*managed{}}
}

// Start gives the manager its lifetime (the application context).
func (m *Manager) Start(ctx context.Context) {
	m.mu.Lock()
	m.appCtx = ctx
	m.mu.Unlock()
}

// LinkInfo is what the UI shows about a vault's cloud connection.
type LinkInfo struct {
	Linked       bool   `json:"linked"`
	CloudVaultID string `json:"cloudVaultId"`
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	ServerURL    string `json:"serverUrl"`
	Locked       bool   `json:"locked"`
	Paused       bool   `json:"paused"`
	PollSeconds  int    `json:"pollSeconds"`
}

// sessionRemote resolves the API client at call time, so a re-login (new
// token source, new server) never leaves an engine holding a stale client.
type sessionRemote struct {
	m     *Manager
	vault string
}

var errSignedOut = errors.New("not signed in to the cloud")

func (r sessionRemote) do(fn func(Remote) error) error {
	c := r.m.session.Client()
	if c == nil {
		return errSignedOut
	}
	return fn(HTTPRemote{C: c, Vault: r.vault})
}

func (r sessionRemote) Tree(ctx context.Context) (t transport.Tree, err error) {
	err = r.do(func(x Remote) error { t, err = x.Tree(ctx); return err })
	return
}

func (r sessionRemote) Changes(ctx context.Context, since int64, limit int) (c transport.Changes, err error) {
	err = r.do(func(x Remote) error { c, err = x.Changes(ctx, since, limit); return err })
	return
}

func (r sessionRemote) CheckBlobs(ctx context.Context, hashes []string) (out []string, err error) {
	err = r.do(func(x Remote) error { out, err = x.CheckBlobs(ctx, hashes); return err })
	return
}

func (r sessionRemote) Upload(ctx context.Context, hash string, data []byte, resume string) (url string, err error) {
	err = r.do(func(x Remote) error { url, err = x.Upload(ctx, hash, data, resume); return err })
	return
}

func (r sessionRemote) Download(ctx context.Context, hash string, w io.Writer) error {
	return r.do(func(x Remote) error { return x.Download(ctx, hash, w) })
}

func (r sessionRemote) RevisionContent(ctx context.Context, fileID string, rev int, w io.Writer) error {
	return r.do(func(x Remote) error { return x.RevisionContent(ctx, fileID, rev, w) })
}

func (r sessionRemote) Commit(ctx context.Context, req syncproto.CommitRequest) (resp syncproto.CommitResponse, err error) {
	err = r.do(func(x Remote) error { resp, err = x.Commit(ctx, req); return err })
	return
}

// Attach opens the vault's sync state and, when the vault is linked and the
// user is signed in, starts synchronizing it.
func (m *Manager) Attach(ctx context.Context, localID string, fs *vault.FS) error {
	sdb, err := store.Open(ctx, filepath.Join(fs.Root(), pathrules.ConfigDir, "sync.db"), store.KindSync)
	if err != nil {
		return err
	}
	mv := &managed{localID: localID, fs: fs, sdb: sdb, db: NewDB(sdb), kick: make(chan struct{}, 1), now: make(chan struct{}, 1)}
	m.mu.Lock()
	if old := m.vaults[localID]; old != nil {
		m.stopLocked(old)
	}
	m.vaults[localID] = mv
	m.mu.Unlock()
	return m.activate(ctx, mv)
}

// activate builds the engine of a linked vault and starts its loop.
func (m *Manager) activate(ctx context.Context, mv *managed) error {
	cloud, err := mv.db.Meta(ctx, MetaCloudVault)
	if err != nil || cloud == "" {
		m.publish(mv)
		return err
	}
	kind, _ := mv.db.Meta(ctx, MetaKind)
	deviceID, _ := mv.db.Meta(ctx, MetaDeviceID)
	userID, _ := mv.db.Meta(ctx, MetaUserID)
	name := ""
	if info, ok := m.session.Info(); ok {
		name = info.DeviceName
		if deviceID == "" {
			deviceID = info.DeviceID
		}
		if userID == "" {
			userID = info.UserID
		}
	}
	cfg := Config{
		LocalID: mv.localID, FS: mv.fs, DB: mv.db, Remote: sessionRemote{m: m, vault: cloud},
		DeviceID: deviceID, DeviceName: name, UserID: userID, Logger: m.log.With().Str("vault", mv.localID).Logger(),
		OnStatus:   func(s Status) { m.emit(EventStatus, s) },
		OnConflict: func(c Conflict) { m.emit(EventConflict, map[string]any{"vaultId": mv.localID, "conflict": c}) },
	}
	if kind == "private" {
		_, _ = m.crypto.Restore(cloud) // unlock silently from the keychain when possible
		cfg.Cipher = m.crypto.Cipher(cloud)
	}
	mv.engine, mv.cloudID, mv.kind = New(cfg), cloud, kind
	m.publish(mv)
	if _, ok := m.session.Info(); ok {
		m.startLoop(mv)
	}
	return nil
}

func (m *Manager) publish(mv *managed) {
	if mv.engine != nil {
		m.emit(EventStatus, mv.engine.Status())
		return
	}
	m.emit(EventStatus, Status{VaultID: mv.localID, Phase: PhaseIdle, Kind: ""})
}

// Detach stops synchronizing a vault and closes its state (vault closed).
func (m *Manager) Detach(localID string) {
	m.mu.Lock()
	mv := m.vaults[localID]
	delete(m.vaults, localID)
	if mv != nil {
		m.stopLocked(mv)
	}
	m.mu.Unlock()
	if mv != nil {
		_ = mv.sdb.Close()
	}
}

// Shutdown stops everything.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.vaults))
	for id := range m.vaults {
		ids = append(ids, id)
	}
	if m.notifier != nil {
		m.notifier()
		m.notifier = nil
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Detach(id)
	}
}

func (m *Manager) stopLocked(mv *managed) {
	if mv.cancel != nil {
		mv.cancel()
		mv.cancel = nil
	}
	mv.running = false
}

func (m *Manager) get(localID string) (*managed, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mv := m.vaults[localID]
	if mv == nil {
		return nil, fmt.Errorf("vault %s is not open", localID)
	}
	return mv, nil
}

func (m *Manager) linked(localID string) (*managed, error) {
	mv, err := m.get(localID)
	if err != nil {
		return nil, err
	}
	if mv.engine == nil {
		return nil, errors.New("this vault is not connected to the cloud")
	}
	return mv, nil
}

// SessionChanged is called when the cloud login changes: loops start when the
// user signs in and stop when they sign out; the realtime stream follows.
func (m *Manager) SessionChanged() {
	info, ok := m.session.Info()
	m.mu.Lock()
	vs := make([]*managed, 0, len(m.vaults))
	for _, v := range m.vaults {
		vs = append(vs, v)
	}
	ctx := m.appCtx
	m.mu.Unlock()
	for _, mv := range vs {
		if mv.engine == nil {
			continue
		}
		if ok {
			m.startLoop(mv)
		} else {
			m.mu.Lock()
			m.stopLocked(mv)
			m.mu.Unlock()
			m.emit(EventStatus, Status{VaultID: mv.localID, Phase: PhaseOffline, Kind: mv.kind, Error: "signed out of the cloud"})
		}
	}
	m.restartNotifier(ctx, info, ok)
}

func (m *Manager) restartNotifier(ctx context.Context, info SessionInfo, signedIn bool) {
	m.mu.Lock()
	if m.notifier != nil {
		m.notifier()
		m.notifier = nil
	}
	m.mu.Unlock()
	m.streamUp.Store(false)
	if !signedIn || ctx == nil {
		return
	}
	c := m.session.Client()
	if c == nil {
		return
	}
	nctx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	m.notifier = cancel
	m.mu.Unlock()
	go c.RunNotifications(nctx, transport.NotifyOptions{
		GRPCEndpoint: info.GRPCEndpoint, DeviceID: info.DeviceID,
		Known: m.knownSeqs,
		Handler: func(ev transport.VaultEvent) {
			m.mu.Lock()
			var targets []*managed
			for _, v := range m.vaults {
				if v.cloudID == ev.VaultID {
					targets = append(targets, v)
				}
			}
			m.mu.Unlock()
			for _, v := range targets {
				m.kickNow(v)
			}
		},
		OnState: func(connected bool, via string) {
			m.streamUp.Store(connected)
			m.log.Debug().Bool("connected", connected).Str("via", via).Msg("notify stream")
		},
	})
}

func (m *Manager) knownSeqs() map[string]int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]int64{}
	for _, v := range m.vaults {
		if v.cloudID != "" {
			if seq, err := v.db.Cursor(context.Background()); err == nil {
				out[v.cloudID] = seq
			}
		}
	}
	return out
}

// Kick asks for a synchronization soon (debounced): the file watcher calls it
// for every local change.
func (m *Manager) Kick(localID string) {
	m.mu.Lock()
	mv := m.vaults[localID]
	m.mu.Unlock()
	if mv != nil && mv.engine != nil {
		select {
		case mv.kick <- struct{}{}:
		default:
		}
	}
}

func (m *Manager) kickNow(mv *managed) {
	select {
	case mv.now <- struct{}{}:
	default:
	}
}

// Renamed forwards a rename (with its link updates) to the engine.
func (m *Manager) Renamed(ctx context.Context, localID, from, to string) {
	mv, err := m.get(localID)
	if err != nil || mv.engine == nil {
		return
	}
	if err := mv.engine.Renamed(ctx, from, to); err != nil {
		m.log.Warn().Err(err).Msg("sync: rename hint failed")
	}
}

const (
	debounce     = 1500 * time.Millisecond
	minPoll      = 30 * time.Second
	maxPoll      = 5 * time.Minute
	maxErrorWait = 5 * time.Minute
)

func (m *Manager) startLoop(mv *managed) {
	m.mu.Lock()
	if mv.running || mv.engine == nil {
		m.mu.Unlock()
		return
	}
	base := m.appCtx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithCancel(base)
	mv.cancel, mv.running = cancel, true
	m.mu.Unlock()
	go m.loop(ctx, mv)
}

// loop is the scheduler of one vault (§3.4.4): sync at start, after local
// changes (debounced), after a server notification, and by polling with an
// adaptive interval (30 s growing to 5 min while idle; 5 min when the realtime
// stream is up). Errors back off exponentially with jitter.
func (m *Manager) loop(ctx context.Context, mv *managed) {
	poll := minPoll
	failures := 0
	next := time.NewTimer(0)
	defer next.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-next.C:
		case <-mv.kick:
			// Collect a burst of changes before syncing.
			t := time.NewTimer(debounce)
		burst:
			for {
				select {
				case <-mv.kick:
					if !t.Stop() {
						<-t.C
					}
					t.Reset(debounce)
				case <-t.C:
					break burst
				case <-ctx.Done():
					t.Stop()
					return
				}
			}
		case <-mv.now:
		}
		err := mv.engine.Sync(ctx)
		var wait time.Duration
		switch {
		case err == nil:
			failures = 0
			if mv.engine.Active() {
				poll = minPoll
			} else {
				poll = min(poll*2, maxPoll)
			}
			wait = poll
			if m.streamUp.Load() {
				wait = maxPoll
			}
			if secs, _ := mv.db.MetaInt(ctx, MetaPollSeconds); secs > 0 {
				wait = time.Duration(max(secs, 15)) * time.Second // the user's choice overrides the adaptive interval
			}
		case errors.Is(err, ErrLocked):
			m.emit(EventLocked, map[string]any{"vaultId": mv.localID})
			wait = maxPoll // an unlock kicks the loop
		case errors.Is(err, ErrPaused):
			wait = maxPoll // resume kicks the loop
		case errors.Is(err, context.Canceled):
			return
		default:
			failures++
			wait = errorBackoff(failures)
			m.log.Warn().Err(err).Dur("retry_in", wait).Msg("sync failed")
		}
		if !next.Stop() {
			select {
			case <-next.C:
			default:
			}
		}
		next.Reset(wait)
	}
}

func errorBackoff(failures int) time.Duration {
	d := 5 * time.Second << min(failures-1, 6)
	if d > maxErrorWait {
		d = maxErrorWait
	}
	return d + time.Duration(rand.Int64N(int64(d/4)+1)) //nolint:gosec // retry jitter, not a security matter
}
