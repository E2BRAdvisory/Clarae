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

	"memobrain/apps/desktop/internal/crypto"
	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

// SessionInfo describes the signed-in account.
type SessionInfo struct {
	ServerURL    string
	DeviceID     string
	UserID       string
	DeviceName   string
	GRPCEndpoint string
	// DeviceRevoked is set, with Info answering "not signed in", while the
	// account is signed in but the cloud refuses its device as revoked.
	DeviceRevoked bool
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
	// EventShares says that shares changed (invitation, revocation, new level): refresh the lists.
	EventShares = "shares:changed"
	// EventConfig says that the distributed configuration has a new revision.
	EventConfig = "config:changed"
)

// Hooks lets the application react to server events the manager only forwards: the share
// and config events arrive on the same realtime stream as the vault ones.
type Hooks struct {
	// Shares is called for every share event (invitation, revocation, update).
	Shares func(transport.ShareEvent)
	// Config is called with the new configuration revision.
	Config func(version int)
	// ConfigVersion returns the revision this device holds (the server replays what is newer).
	ConfigVersion func() int
	// BeforeOverwrite is called before a merge replaces local content that the
	// server does not have, so the application can snapshot it (local history).
	BeforeOverwrite func(localVaultID, path string)
	// DeviceRevoked is called when the cloud refuses a commit because the device
	// it was sent with is revoked; every engine using it has been stopped.
	DeviceRevoked func(deviceID string)
}

// SetManagedPoll sets the polling interval distributed by the administrator (0 = none).
// Unless locked it only replaces the automatic interval; a user's own choice stands.
func (m *Manager) SetManagedPoll(seconds int, locked bool) {
	m.managedPoll.Store(int64(seconds))
	m.managedLocked.Store(locked)
}

// SetMaxFileBytes sets the largest file the engines upload (0 = the protocol
// default). Larger files are parked before being read or encrypted.
func (m *Manager) SetMaxFileBytes(n int64) { m.maxFile.Store(n) }

func (m *Manager) maxFileBytes() int64 {
	if n := m.maxFile.Load(); n > 0 {
		return n
	}
	return syncproto.DefaultMaxFileBytes
}

// SetLockTimeout sets how long an unlocked private vault may stay idle before
// its key is forgotten (0 = never).
func (m *Manager) SetLockTimeout(d time.Duration) { m.crypto.SetLockTimeout(d) }

// SetEnvelopeV2 switches the writing of v2 key envelopes (ADR-0034,
// features.envelope_v2): at creation, on passphrase or recovery key changes
// and as an upgrade after an unlock.
func (m *Manager) SetEnvelopeV2(on bool) { m.crypto.SetEnvelopeV2(on) }

// SetPathV2 switches the writing of enc2 path tokens, bound to their file
// (ADR-0042, features.path_v2). A vault already pinned to enc2 keeps writing
// enc2 whatever the flag.
func (m *Manager) SetPathV2(on bool) { m.crypto.SetPathV2(on) }

// idleLockInterval is how often idle private vaults are looked for.
const idleLockInterval = 30 * time.Second

// lockIdleVaults locks the private vaults idle past the timeout and tells the
// UI. Each one first pushes what waits for upload (drainAndLock): the key is
// forgotten only afterwards, and only if the vault was not unlocked again
// meanwhile. A key no open vault uses is simply forgotten.
func (m *Manager) lockIdleVaults() {
	m.mu.Lock()
	ctx := m.appCtx
	m.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	for _, cloud := range m.crypto.IdleVaults() {
		err := m.drainAndLock(ctx, cloud, LockReasonIdle, func() (bool, error) {
			return m.crypto.LockExpired(cloud)
		})
		if err != nil {
			m.log.Warn().Err(err).Msg("sync: idle lock")
		}
	}
}

// SetHooks installs the application's event hooks; call it before Start.
func (m *Manager) SetHooks(h Hooks) {
	m.mu.Lock()
	m.hooks = h
	m.mu.Unlock()
}

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
	hooks    Hooks
	// managed polling interval from the distributed configuration (§2.6.6).
	managedPoll   atomic.Int64
	managedLocked atomic.Bool
	// maxFile is the upload size limit from the distributed configuration (0 = default).
	maxFile atomic.Int64
	// remoteFor builds the server side of an engine (tests replace it; nil = the session's client).
	remoteFor func(ref string) Remote
	// reactivating serializes the rebuild of the engines after the session's
	// device changed (see SessionChanged).
	reactivating stdsync.Mutex
}

type managed struct {
	localID string
	fs      *vault.FS
	sdb     *sql.DB
	db      *DB
	kick    chan struct{}
	now     chan struct{} // immediate sync request (skips the debounce)
	req     chan struct{} // SyncNow: a cycle with a fresh scan, unless one ran since (Engine.RequestScan)

	// Guarded by Manager.mu: activate, Unlink and the loops change them
	// concurrently with the UI calls (read them through linked/engineOf).
	engine  *Engine
	cloudID string
	kind    string
	scope   string // share scope of a mount ("" for a vault of one's own)
	cancel  context.CancelFunc
	running bool
	done    chan struct{} // closed when the last started loop has returned
}

// linkView is a consistent snapshot of a linked vault's engine and identity,
// taken under Manager.mu; its fields shadow the live ones of managed.
type linkView struct {
	*managed
	engine  *Engine
	cloudID string
	kind    string
	scope   string
}

// engineOf returns the current engine of a vault (nil when not linked).
func (m *Manager) engineOf(mv *managed) *Engine {
	m.mu.Lock()
	defer m.mu.Unlock()
	return mv.engine
}

// waitLoop blocks until a loop stopped by stopLocked has returned. Call it
// without holding m.mu: the loop takes it on its way out.
func waitLoop(done <-chan struct{}) {
	if done != nil {
		<-done
	}
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
	go func() {
		t := time.NewTicker(idleLockInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.lockIdleVaults()
			}
		}
	}()
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
	// Mount is set when the vault is a share received from someone else.
	Mount bool `json:"mount"`
	// Permission is owner, or the level of the share on a mount; ReadOnly follows from it.
	Permission string `json:"permission"`
	ReadOnly   bool   `json:"readOnly"`
	Revoked    bool   `json:"revoked"`
	OwnerName  string `json:"ownerName"`
	ShareID    string `json:"shareId"`
}

// sessionRemote resolves the API client at call time, so a re-login (new
// token source, new server) never leaves an engine holding a stale client.
type sessionRemote struct {
	m     *Manager
	vault string
}

var errSignedOut = errors.New("not signed in to the cloud")

// remote returns the server side of the engine of a vault reference.
func (m *Manager) remote(ref string) Remote {
	if m.remoteFor != nil {
		return m.remoteFor(ref)
	}
	return sessionRemote{m: m, vault: ref}
}

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

// FolderShareRoots implements FolderShareRooter.
func (r sessionRemote) FolderShareRoots(ctx context.Context) ([]string, error) {
	c := r.m.session.Client()
	if c == nil {
		return nil, errSignedOut
	}
	return HTTPRemote{C: c, Vault: r.vault}.FolderShareRoots(ctx)
}

// Attach opens the vault's sync state and, when the vault is linked and the
// user is signed in, starts synchronizing it.
func (m *Manager) Attach(ctx context.Context, localID string, fs *vault.FS) error {
	sdb, err := store.Open(ctx, filepath.Join(fs.Root(), pathrules.ConfigDir, "sync.db"), store.KindSync)
	if err != nil {
		return err
	}
	mv := &managed{localID: localID, fs: fs, sdb: sdb, db: NewDB(sdb), kick: make(chan struct{}, 1), now: make(chan struct{}, 1), req: make(chan struct{}, 1)}
	m.mu.Lock()
	old := m.vaults[localID]
	var oldDone <-chan struct{}
	if old != nil {
		oldDone = m.stopLocked(old)
	}
	m.vaults[localID] = mv
	m.mu.Unlock()
	if old != nil {
		// The replaced entry's loop must be gone before its database closes
		// and before a second engine starts on the same folder.
		waitLoop(oldDone)
		_ = old.sdb.Close()
	}
	return m.activate(ctx, mv)
}

// activate builds the engine of a linked vault and starts its loop. A loop
// still running on the vault is stopped and waited for first: two engines on
// one folder would not serialize their cycles.
func (m *Manager) activate(ctx context.Context, mv *managed) error {
	m.mu.Lock()
	done := m.stopLocked(mv)
	m.mu.Unlock()
	waitLoop(done)
	cloud, err := mv.db.Meta(ctx, MetaCloudVault)
	if err != nil || cloud == "" {
		m.publish(mv)
		return err
	}
	kind, _ := mv.db.Meta(ctx, MetaKind)
	mount, isMount, _ := readMountMeta(ctx, mv.db)
	if isMount && mount.Revoked {
		m.publish(mv)
		return nil // the share is gone: nothing to sync until the user decides what to do with the copy
	}
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
		if m.sessionDeviceApplies(ctx, mv, info, deviceID, userID) {
			// The account registered a new device (after a revocation, or at a new
			// sign-in): the vault commits with it from now on. Only commits carry the
			// device id, so nothing else changes; the outbox goes out with it.
			deviceID = info.DeviceID
			if err := mv.db.SetMeta(ctx, MetaDeviceID, deviceID); err != nil {
				m.log.Warn().Err(err).Msg("sync: record the new device id")
			}
		}
	}
	cfg := Config{
		LocalID: mv.localID, FS: mv.fs, DB: mv.db, Remote: m.remote(transport.Ref(cloud, mount.Scope)),
		ReadOnly: isMount && mount.Permission == PermViewer,
		DeviceID: deviceID, DeviceName: name, UserID: userID, Logger: m.log.With().Str("vault", mv.localID).Logger(),
		OnStatus:     func(s Status) { m.emit(EventStatus, m.view(s)) },
		OnConflict:   func(c Conflict) { m.emit(EventConflict, map[string]any{"vaultId": mv.localID, "conflict": c}) },
		MaxFileBytes: m.maxFileBytes,
		BeforeOverwrite: func(path string) {
			m.mu.Lock()
			hook := m.hooks.BeforeOverwrite
			m.mu.Unlock()
			if hook != nil {
				hook(mv.localID, path)
			}
		},
	}
	if kind == "private" {
		_, _ = m.crypto.Restore(cloud) // unlock silently from the keychain when possible
		cfg.Cipher = m.crypto.Cipher(cloud)
	}
	eng := New(cfg)
	m.mu.Lock()
	mv.engine, mv.cloudID, mv.kind, mv.scope = eng, cloud, kind, mount.Scope
	m.mu.Unlock()
	m.publish(mv)
	if _, ok := m.session.Info(); ok {
		m.startLoop(mv)
	}
	return nil
}

// sessionDeviceApplies reports whether a vault linked with deviceID by userID
// should commit with the session's device instead: same account, same server,
// another device. A vault linked on another server or by another account keeps
// its own.
func (m *Manager) sessionDeviceApplies(ctx context.Context, mv *managed, info SessionInfo, deviceID, userID string) bool {
	if info.DeviceID == "" || deviceID == info.DeviceID || userID != info.UserID {
		return false
	}
	server, _ := mv.db.Meta(ctx, MetaServerURL)
	return server == "" || server == info.ServerURL
}

// staleDevice reports whether the engine of a vault commits with a device the
// session has replaced (see sessionDeviceApplies).
func (m *Manager) staleDevice(ctx context.Context, mv *managed, info SessionInfo) bool {
	eng := m.engineOf(mv)
	if eng == nil {
		return false
	}
	userID, _ := mv.db.Meta(ctx, MetaUserID)
	if userID == "" {
		userID = info.UserID
	}
	return m.sessionDeviceApplies(ctx, mv, info, eng.DeviceID(), userID)
}

// reactivate rebuilds the engine of a vault whose device was replaced, so it
// commits with the new one. It runs on its own goroutine: SessionChanged may be
// called from inside a sync cycle (a token refresh), which activate waits for.
func (m *Manager) reactivate(mv *managed) {
	m.reactivating.Lock()
	defer m.reactivating.Unlock()
	m.mu.Lock()
	ctx, current := m.appCtx, m.vaults[mv.localID] == mv
	m.mu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	info, ok := m.session.Info()
	if !current || !ok || !m.staleDevice(ctx, mv, info) {
		return
	}
	if err := m.activate(ctx, mv); err != nil {
		m.log.Warn().Err(err).Str("vault", mv.localID).Msg("sync: restart with the new device")
	}
}

// deviceRevoked stops every engine that commits with the revoked device (all of
// them, normally: they share the session's device) and tells the application,
// which moves the session to device_revoked. Nothing local is touched: files,
// sync.db and the outbox stay as they are and go out once the device is
// registered again (SessionChanged then restarts the engines with the new id).
func (m *Manager) deviceRevoked(id string) {
	m.mu.Lock()
	var stopped []*Engine
	for _, v := range m.vaults {
		if v.engine != nil && v.engine.DeviceID() == id {
			m.stopLocked(v) // called from a loop: never wait here
			stopped = append(stopped, v.engine)
		}
	}
	hook := m.hooks.DeviceRevoked
	m.mu.Unlock()
	m.log.Warn().Str("device", id).Int("vaults", len(stopped)).Msg("sync: the cloud refuses this device as revoked; synchronization stopped")
	for _, eng := range stopped {
		m.emit(EventStatus, revokedView(eng.Status())) // the session may not say "revoked" yet: the hook below does
	}
	if hook != nil {
		hook(id)
	}
}

func (m *Manager) publish(mv *managed) {
	if eng := m.engineOf(mv); eng != nil {
		m.emit(EventStatus, m.view(eng.Status()))
		return
	}
	m.emit(EventStatus, Status{VaultID: mv.localID, Phase: PhaseIdle, Kind: ""})
}

// Detach stops synchronizing a vault and closes its state (vault closed). It
// returns once the vault's loop is gone, so no cycle uses the closed database.
func (m *Manager) Detach(localID string) {
	m.mu.Lock()
	mv := m.vaults[localID]
	delete(m.vaults, localID)
	var done <-chan struct{}
	if mv != nil {
		done = m.stopLocked(mv)
	}
	m.mu.Unlock()
	if mv != nil {
		waitLoop(done)
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

// stopLocked cancels the vault's loop (m.mu held) and returns the channel
// closed when it has returned; callers that free or replace what the loop uses
// wait on it with waitLoop after releasing m.mu. The loop itself must not wait.
func (m *Manager) stopLocked(mv *managed) <-chan struct{} {
	if mv.cancel != nil {
		mv.cancel()
		mv.cancel = nil
	}
	mv.running = false
	return mv.done
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

func (m *Manager) linked(localID string) (linkView, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mv := m.vaults[localID]
	if mv == nil {
		return linkView{}, fmt.Errorf("vault %s is not open", localID)
	}
	if mv.engine == nil {
		return linkView{}, errors.New("this vault is not connected to the cloud")
	}
	return linkView{managed: mv, engine: mv.engine, cloudID: mv.cloudID, kind: mv.kind, scope: mv.scope}, nil
}

// SessionChanged is called when the cloud login changes: loops start when the
// user signs in and stop when they sign out; the realtime stream follows.
func (m *Manager) SessionChanged() {
	info, ok := m.session.Info()
	m.mu.Lock()
	vs := make([]*managed, 0, len(m.vaults))
	for _, v := range m.vaults {
		if v.engine != nil {
			vs = append(vs, v)
		}
	}
	ctx := m.appCtx
	m.mu.Unlock()
	for _, mv := range vs {
		switch {
		case ok && m.staleDevice(ctx2(ctx), mv, info):
			go m.reactivate(mv) // a new device: a new engine, which starts its loop
		case ok:
			m.startLoop(mv)
		default:
			m.mu.Lock()
			m.stopLocked(mv) // the same engine restarts at sign-in: no need to wait
			kind, eng := mv.kind, mv.engine
			m.mu.Unlock()
			if info.DeviceRevoked {
				m.emit(EventStatus, revokedView(eng.Status()))
				continue
			}
			m.emit(EventStatus, Status{VaultID: mv.localID, Phase: PhaseOffline, Kind: kind, Error: "signed out of the cloud"})
		}
	}
	m.restartNotifier(ctx, info, ok)
}

// ctx2 is ctx, or a background context before Start.
func ctx2(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
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
		OnShare: func(ev transport.ShareEvent) {
			m.emit(EventShares, map[string]any{"shareId": ev.ShareID, "kind": ev.Kind})
			if h := m.hooksSnapshot().Shares; h != nil {
				h(ev)
			}
		},
		OnConfig: func(version int) {
			m.emit(EventConfig, map[string]any{"version": version})
			if h := m.hooksSnapshot().Config; h != nil {
				h(version)
			}
		},
		ConfigVersion: func() int {
			if h := m.hooksSnapshot().ConfigVersion; h != nil {
				return h()
			}
			return 0
		},
		OnState: func(connected bool, via string) {
			m.streamUp.Store(connected)
			m.log.Debug().Bool("connected", connected).Str("via", via).Msg("notify stream")
		},
	})
}

func (m *Manager) hooksSnapshot() Hooks {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.hooks
}

// knownSeqs is the replay position per cloud vault. Several mounts can come from one cloud
// vault (two shares of different folders), each with its own cursor: the lowest wins so
// that none of them misses an event after a reconnect.
func (m *Manager) knownSeqs() map[string]int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]int64{}
	for _, v := range m.vaults {
		if v.cloudID == "" {
			continue
		}
		seq, err := v.db.Cursor(context.Background())
		if err != nil {
			continue
		}
		if cur, ok := out[v.cloudID]; !ok || seq < cur {
			out[v.cloudID] = seq
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
	if err != nil {
		return
	}
	eng := m.engineOf(mv)
	if eng == nil {
		return
	}
	if err := eng.Renamed(ctx, from, to); err != nil {
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
	prev, done := mv.done, make(chan struct{})
	mv.cancel, mv.running, mv.done = cancel, true, done
	eng, scope := mv.engine, mv.scope
	m.mu.Unlock()
	go func() {
		defer close(done)
		// A loop stopped without waiting (sign-out, revocation) may still be
		// finishing its cycle: never run two at once.
		if prev != nil {
			select {
			case <-prev:
			case <-ctx.Done():
				return
			}
		}
		m.loop(ctx, mv, eng, scope)
	}()
}

// loop is the scheduler of one vault (§3.4.4): sync at start, after local
// changes (debounced), after a server notification, and by polling with an
// adaptive interval (30 s growing to 5 min while idle; 5 min when the realtime
// stream is up). Errors back off exponentially with jitter.
// The engine and the scope are the ones the loop was started with: activate
// and Unlink change mv's fields only after stopping and waiting for it.
func (m *Manager) loop(ctx context.Context, mv *managed, eng *Engine, scope string) {
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
		case <-mv.req:
			if !eng.ScanDue() {
				continue // a cycle scanned after the request already: nothing to add
			}
		}
		err := eng.Sync(ctx)
		var wait time.Duration
		switch {
		case err == nil:
			failures = 0
			if eng.Active() {
				poll = minPoll
			} else {
				poll = min(poll*2, maxPoll)
			}
			wait = poll
			if m.streamUp.Load() {
				wait = maxPoll
			}
			secs, _ := mv.db.MetaInt(ctx, MetaPollSeconds)
			if managed := int(m.managedPoll.Load()); managed > 0 && (secs == 0 || m.managedLocked.Load()) {
				secs = managed // the administrator's interval: a default, or binding when the key is locked
			}
			if secs > 0 {
				wait = time.Duration(max(secs, 15)) * time.Second // the chosen interval overrides the adaptive one
			}
		case errors.Is(err, ErrLocked):
			// Record the local changes the cycle could not see, so the
			// count of what waits for the next unlock is right.
			var scanErr error
			_ = eng.Exclusive(func() error { scanErr = eng.scan(ctx); return nil })
			m.emit(EventLocked, m.lockedEvent(ctx, mv.localID, eng, mv.db, LockReasonSync, scanErr))
			wait = maxPoll // an unlock kicks the loop
		case errors.Is(err, ErrPaused):
			wait = maxPoll // resume kicks the loop
		case errors.Is(err, context.Canceled):
			return
		case transport.IsDeviceRevoked(err):
			m.deviceRevoked(eng.DeviceID())
			return
		case scope != "" && isRevocation(err):
			m.markRevoked(ctx, mv)
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
