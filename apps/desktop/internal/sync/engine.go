package sync

import (
	"context"
	"errors"
	"fmt"
	"strings"
	stdsync "sync"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/crypto"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/hashing"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

// Phase is what the engine is doing, for the status indicator.
type Phase string

// Phases.
const (
	PhaseIdle    Phase = "idle"
	PhaseSyncing Phase = "syncing"
	PhasePaused  Phase = "paused"
	PhaseOffline Phase = "offline"
	PhaseError   Phase = "error"
	PhaseLocked  Phase = "locked"
)

// Status is published as the sync:status event.
type Status struct {
	VaultID   string    `json:"vaultId"` // local vault id (as used by the UI)
	Phase     Phase     `json:"phase"`
	LastSync  time.Time `json:"lastSync"`
	Pending   int       `json:"pending"`
	Conflicts int       `json:"conflicts"`
	Done      int       `json:"done"`
	Total     int       `json:"total"`
	Error     string    `json:"error"`
	Kind      string    `json:"kind"`
	// Quarantined counts the server entries this device cannot read (an
	// undecryptable path): they are neither applied nor taken for deletions.
	Quarantined int `json:"quarantined"`
}

// ErrLocked means the private vault must be unlocked before it can sync.
var ErrLocked = errors.New("vault is locked")

// ErrUnlinked means the engine belongs to a link that no longer exists: the
// vault was disconnected (Manager.Unlink) while something still held it.
var ErrUnlinked = errors.New("this vault is not connected to the cloud")

// ErrPaused means synchronization is paused for this vault.
var ErrPaused = errors.New("synchronization is paused")

// DeviceRevokedMessage is Status.Error while the cloud refuses this device as
// revoked: synchronization stops until the device is registered again.
const DeviceRevokedMessage = "this device was revoked from your account: register it again to resume synchronization"

// ErrDeviceRevoked is returned by the operations that need the cloud while
// this device is revoked.
var ErrDeviceRevoked = errors.New(DeviceRevokedMessage)

// revokedView is how a status reads while the device is revoked: offline with
// the reason, except for a locked or paused vault, which says that first.
func revokedView(st Status) Status {
	if st.Phase != PhaseLocked && st.Phase != PhasePaused {
		st.Phase, st.Error = PhaseOffline, DeviceRevokedMessage
	}
	return st
}

// Config wires an Engine.
type Config struct {
	LocalID    string // vault id in the UI
	FS         *vault.FS
	DB         *DB
	Remote     Remote
	Cipher     Cipher // nil for shared vaults
	DeviceID   string
	DeviceName string
	UserID     string
	// ReadOnly makes the engine pull only (a viewer of a share): local edits are never sent.
	ReadOnly bool
	CacheDir string // where prepared ciphertext is kept (default <vault>/.memobrain/cache/outbox)
	Logger   zerolog.Logger
	Now      func() time.Time
	// OnStatus and OnConflict receive updates (may be nil).
	OnStatus   func(Status)
	OnConflict func(Conflict)
	// MaxFileBytes returns the largest file to upload (nil or 0: the protocol
	// default). Larger files are parked before being read or encrypted (§3.4.2).
	MaxFileBytes func() int64
	// BeforeOverwrite is called before a merge replaces local content the server
	// does not have (may be nil): the application snapshots it (§2.9).
	BeforeOverwrite func(path string)
	// PathMigrationBatch and PathMigrationSpacing tune the background rewrite
	// of enc1 path tokens (ADR-0042, pathmigrate.go): files per batch and
	// least time between two batches (0: the defaults).
	PathMigrationBatch   int
	PathMigrationSpacing time.Duration
	// Transfers is how many blobs a cycle downloads or uploads at once
	// (0: DefaultTransfers, 1: one at a time). The changes are applied in
	// their order whatever it is (transfers.go).
	Transfers int
}

// Engine synchronizes one vault. Sync calls are serialized.
type Engine struct {
	cfg Config
	log zerolog.Logger

	// run serializes the cycles and the other users of sync_files (Exclusive,
	// the rename hints). Take it with lockRun and release it with unlockRun:
	// both apply the queued rename hints (see Renamed).
	run stdsync.Mutex

	mu     stdsync.Mutex
	status Status
	// lastScan is when the last complete scan started (see scan); it is kept
	// in sync.db so the first scan after a restart trusts the same files a
	// later scan would. scanLoaded: it was read from sync.db (under e.run).
	lastScan   time.Time
	scanLoaded bool
	// hashFile hashes a vault file (FS.HashFile; replaced by tests to count reads).
	hashFile func(rel string) (string, int64, error)
	// readFile reads the content to push (FS.ReadFile; replaced by tests to
	// measure what is held), batchBytes caps the content of one push batch
	// (maxBatchBytes; lowered by tests).
	readFile   func(rel string) (vault.Content, error)
	batchBytes int
	// candidates are remote changes that hit a locally modified file; they
	// are resolved after the pull completed (§3.4.4 B). They mirror the
	// pending_remote table (loaded once per run, under e.run): staged are the
	// ones not written yet, saved with the next cursor update.
	candidates    map[string]transportChange
	staged        map[string]bool
	pendingLoaded bool
	// stop is set when a cycle must end early (quota, auth).
	stop error
	// active is true when the last cycle found something to do.
	active bool
	// tmpCleaned: stale atomic-write staging files were removed (once per run, under e.run).
	tmpCleaned bool
	// quarantineChecked: the quarantined entries were read again in this run
	// (retryQuarantine, or a bootstrap; under e.run).
	quarantineChecked bool
	// retired is set, under e.run, once the link the engine serves is gone
	// (Unlink): it never runs a cycle again nor writes sync.db.
	retired bool
	// pathV2Pinned and pathStrong cache the vault's enc2 pins (ADR-0042, see
	// clearPath and writePathV2), read from sync.db once (pathPinLoaded,
	// under e.run).
	pathV2Pinned  bool
	pathStrong    bool
	pathPinLoaded bool
	// migration is the state of the background rewrite of enc1 path tokens
	// (pathmigrate.go, under e.run); migrating says it has work left, for the
	// scheduler (under e.mu).
	migration pathMigration
	migrating bool
	// noPrefix are the folder renames the server refused as a move_prefix
	// (sent file by file since), forcedPrefix the share-root renames deduced
	// from a SHARE_ROOT_MOVE, to send in the next round (see folders.go;
	// both under e.run, keyed by prefixPair.key).
	noPrefix     map[string]bool
	forcedPrefix map[string]forcedMove
	// scans counts the scans started; wantScan is the scan a SyncNow waits for
	// (see RequestScan). Both under e.mu.
	scans, wantScan uint64
	// renames are the rename hints (Renamed) not applied yet, oldest first
	// (under e.mu). Renamed never waits for e.run: whoever holds it applies
	// them at its next safe point (applyRenames).
	renames []renameHint
}

// renameHint is a file or folder moved by the user (Renamed).
type renameHint struct{ from, to string }

// New creates the engine.
func New(cfg Config) *Engine {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.CacheDir == "" {
		cfg.CacheDir = cfg.FS.Root() + "/" + pathrules.ConfigDir + "/cache/outbox"
	}
	e := &Engine{
		cfg: cfg, log: cfg.Logger, candidates: map[string]transportChange{}, staged: map[string]bool{}, hashFile: cfg.FS.HashFile,
		readFile: cfg.FS.ReadFile, batchBytes: maxBatchBytes,
		noPrefix: map[string]bool{}, forcedPrefix: map[string]forcedMove{},
	}
	e.status = Status{VaultID: cfg.LocalID, Phase: PhaseIdle}
	if cfg.Cipher != nil {
		e.status.Kind = "private"
	} else {
		e.status.Kind = "shared"
	}
	return e
}

// DeviceID is the id the engine commits with.
func (e *Engine) DeviceID() string { return e.cfg.DeviceID }

// Status returns the latest status.
func (e *Engine) Status() Status {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.status
}

func (e *Engine) setStatus(mutate func(*Status)) {
	e.mu.Lock()
	mutate(&e.status)
	s := e.status
	e.mu.Unlock()
	if e.cfg.OnStatus != nil {
		e.cfg.OnStatus(s)
	}
}

// RequestScan asks for a cycle whose scan of the disk starts after this call
// (SyncNow: a file written just before must be seen). Until such a cycle has
// completed, Status says PhaseSyncing rather than a stale idle, and a cycle
// that started earlier ends in PhaseSyncing too: the scheduler runs the next
// one at once. Several requests made before that scan are one request.
func (e *Engine) RequestScan() {
	e.mu.Lock()
	if e.wantScan <= e.scans {
		e.wantScan = e.scans + 1
	}
	publish := e.status.Phase == PhaseIdle
	if publish {
		e.status.Phase = PhaseSyncing
	}
	s := e.status
	e.mu.Unlock()
	if publish && e.cfg.OnStatus != nil {
		e.cfg.OnStatus(s)
	}
}

// ScanDue reports whether a scan asked with RequestScan has not started yet.
func (e *Engine) ScanDue() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.wantScan > e.scans
}

func (e *Engine) progress(done, total int) {
	e.setStatus(func(s *Status) { s.Done, s.Total = done, total })
}

// Sync runs reconciliation rounds until nothing is left to do (or the round
// limit is reached): scan local changes, pull, resolve, push.
func (e *Engine) Sync(ctx context.Context) (err error) {
	e.lockRun(ctx)
	defer e.unlockRun()

	if e.retired {
		return ErrUnlinked
	}
	if paused, _ := e.cfg.DB.Meta(ctx, MetaPaused); paused == "1" {
		e.setStatus(func(s *Status) { s.Phase = PhasePaused })
		return ErrPaused
	}
	if e.cfg.Cipher != nil && e.cfg.Cipher.Locked() {
		e.setStatus(func(s *Status) { s.Phase = PhaseLocked; s.Error = "" })
		return ErrLocked
	}
	e.setStatus(func(s *Status) { s.Phase = PhaseSyncing; s.Error = ""; s.Done, s.Total = 0, 0 })
	defer func() {
		pending, _ := e.cfg.DB.PendingCount(ctx)
		conflicts, _ := e.cfg.DB.OpenConflictCount(ctx)
		quarantined, _ := e.cfg.DB.QuarantineCount(ctx)
		notice := ""
		if err == nil {
			// Not a failure of the cycle (no backoff), but the user must know.
			notice = e.shareRootNotice(ctx)
		}
		e.setStatus(func(s *Status) {
			s.Pending, s.Conflicts, s.Quarantined = pending, conflicts, quarantined
			s.Done, s.Total = 0, 0
			switch {
			case err == nil && e.wantScan > e.scans:
				// A SyncNow came after this cycle's last scan: the next cycle runs at once.
				s.Phase, s.LastSync, s.Error = PhaseSyncing, e.cfg.Now(), notice
			case err == nil:
				s.Phase, s.LastSync, s.Error = PhaseIdle, e.cfg.Now(), notice
			case errors.Is(err, ErrLocked):
				s.Phase, s.Error = PhaseLocked, ""
			case errors.Is(err, context.Canceled):
				s.Phase = PhaseIdle
			case transport.IsDeviceRevoked(err):
				s.Phase, s.Error = PhaseOffline, DeviceRevokedMessage
			case isNetwork(err):
				s.Phase, s.Error = PhaseOffline, err.Error()
			default:
				s.Phase, s.Error = PhaseError, err.Error()
			}
		})
	}()

	e.mu.Lock()
	e.stop = nil
	e.active = false
	e.mu.Unlock()
	if err := e.loadPending(ctx); err != nil {
		return fmt.Errorf("load pending changes: %w", err)
	}
	if !e.tmpCleaned {
		// Staging files of a write that crashed are never synced (pathrules); remove them once.
		e.tmpCleaned = true
		if n, err := e.cfg.FS.CleanStaleTemp(time.Minute); err == nil && n > 0 {
			e.log.Info().Int("files", n).Msg("removed stale temporary files of interrupted writes")
		}
	}
	var resolveErr error // files that could not be resolved: reported once the others are pushed
	for round := 0; round < 6; round++ {
		// The rename hints that came during the previous steps are applied
		// between them, never inside one (the bootstrap and the push work on
		// rows read at their start). So a rename made during a long cycle
		// keeps its identity: before the scan; before the remote changes are
		// merged (one that found the old path gone then finds the file at the
		// new one); before the push (which would otherwise send the delete
		// plus create that a scan between the move and the hint recorded).
		e.flushRenames(ctx)
		if err := e.scan(ctx); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		pulled, err := e.pull(ctx)
		if err != nil {
			return fmt.Errorf("pull: %w", err)
		}
		e.flushRenames(ctx)
		resolved, err := e.resolveCandidates(ctx)
		var failure *resolveFailure
		switch {
		case errors.As(err, &failure):
			resolveErr = fmt.Errorf("resolve: %w", err)
		case err != nil:
			return fmt.Errorf("resolve: %w", err)
		}
		pushed := false
		if !e.cfg.ReadOnly {
			e.flushRenames(ctx)
			if pushed, err = e.push(ctx); err != nil {
				return fmt.Errorf("push: %w", err)
			}
		}
		e.mu.Lock()
		stop := e.stop
		e.mu.Unlock()
		if stop != nil {
			return stop
		}
		if !pulled && !resolved && !pushed {
			_ = e.cfg.DB.PruneOutbox(ctx)
			// Nothing else to do: one throttled batch of the path token
			// migration (it never fails the cycle).
			e.migratePaths(ctx)
			return resolveErr
		}
		e.mu.Lock()
		e.active = true
		e.mu.Unlock()
	}
	return resolveErr
}

// Active reports whether the last cycle found anything to pull or push (the
// scheduler polls faster after activity and backs off while idle).
func (e *Engine) Active() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.active
}

// Exclusive runs fn while no synchronization cycle is running; used for
// operations that edit vault files on behalf of the user (conflict resolution).
// A retired engine runs nothing (ErrUnlinked).
func (e *Engine) Exclusive(fn func() error) error {
	e.lockRun(context.Background())
	defer e.unlockRun()
	if e.retired {
		return ErrUnlinked
	}
	return fn()
}

// lockRun takes e.run, then applies the rename hints queued while somebody
// else had it: whoever gets e.run sees the renames made before.
func (e *Engine) lockRun(ctx context.Context) {
	e.run.Lock()
	e.flushRenames(ctx)
}

// unlockRun releases e.run. A hint queued after the holder's last safe point
// found e.run taken (Renamed only tries it), so it is applied here, unless
// somebody got e.run meanwhile: that holder applies it (lockRun, Renamed) or
// comes back here. Every hint is so applied by the holder it found, or by the
// first one after it, never left waiting for a later cycle.
func (e *Engine) unlockRun() {
	for {
		e.run.Unlock()
		if !e.renamesQueued() || !e.run.TryLock() {
			return
		}
		e.flushRenames(context.Background())
	}
}

func (e *Engine) renamesQueued() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.renames) > 0
}

// flushRenames applies the queued rename hints for a holder of e.run that
// cannot report their failure: it is logged (the rename is done on disk, only
// the file identity may be lost, as with a hint that never came).
func (e *Engine) flushRenames(ctx context.Context) {
	if err := e.applyRenames(ctx); err != nil {
		e.log.Warn().Err(err).Msg("sync: rename hint failed")
	}
}

// applyRenames applies the queued rename hints in the order they came, each
// in its own transaction (under e.run). A hint that fails is dropped, as a
// failed hint always was: retrying a database error forever would hold back
// the ones queued after it. A cancelled cycle still applies them: they record
// renames already done on disk.
func (e *Engine) applyRenames(ctx context.Context) error {
	ctx = context.WithoutCancel(ctx)
	var errs []error
	for {
		e.mu.Lock()
		if e.retired {
			// Nothing to keep the identity for: the vault is no longer linked.
			e.renames = nil
		}
		if len(e.renames) == 0 {
			e.renames = nil
			e.mu.Unlock()
			return errors.Join(errs...)
		}
		h := e.renames[0]
		e.renames = e.renames[1:]
		e.mu.Unlock()
		if err := e.applyRename(ctx, h.from, h.to); err != nil {
			errs = append(errs, fmt.Errorf("rename %s to %s: %w", h.from, h.to, err))
		}
	}
}

// retire waits for the running cycle (or Exclusive call) to end, runs reset
// and makes the engine refuse every later one: whoever still holds it (a
// drain before a lock, captured before the vault was unlinked) can no longer
// write the state reset erases. Queued rename hints are dropped.
func (e *Engine) retire(reset func() error) error {
	e.lockRun(context.Background())
	defer e.unlockRun()
	e.retired = true
	return reset()
}

// Renamed tells the engine that a file or folder moved so identity survives
// even if the move also rewrote content (link updates): without this hint a
// renamed-and-edited note would look like a delete plus a new file (§3.4.4 A).
//
// It never waits for a running cycle, which may take minutes (the binding that
// renamed the file waits for this call). The hint is queued; when e.run is
// free it is applied at once and its error returned, otherwise the holder of
// e.run applies it at its next safe point (Sync, unlockRun). Hints are applied
// in the order they came.
func (e *Engine) Renamed(ctx context.Context, from, to string) error {
	e.mu.Lock()
	e.renames = append(e.renames, renameHint{from: from, to: to})
	e.mu.Unlock()
	if !e.run.TryLock() {
		return nil // taken: its holder applies the hint
	}
	defer e.unlockRun()
	return e.applyRenames(ctx)
}

// applyRename records one rename in sync_files (under e.run). A scan that ran
// between the move and the hint may already have recorded the new path as a
// new file (and the old one as deleted): the two rows are merged back into the
// original identity. Everything happens in one transaction.
func (e *Engine) applyRename(ctx context.Context, from, to string) error {
	return e.cfg.DB.WithTx(ctx, func(tx *DB) error {
		rows, err := tx.Files(ctx)
		if err != nil {
			return err
		}
		target := func(p string) (string, bool) {
			switch {
			case p == from:
				return to, true
			case pathrules.HasPrefix(p, from):
				return to + p[len(from):], true
			}
			return "", false
		}
		byPath := make(map[string]File, len(rows))
		moving := map[string]bool{} // file ids that follow the move
		for _, r := range rows {
			byPath[r.Path] = r
			if _, ok := target(r.Path); ok {
				moving[r.FileID] = true
			}
		}
		for _, r := range rows {
			np, ok := target(r.Path)
			if !ok {
				continue
			}
			var adopted *File
			if other, taken := byPath[np]; taken && !moving[other.FileID] {
				if other.State == StateLocalNew && other.ServerRev == 0 {
					// The scan saw the moved file as a new one: it is this file.
					if err := tx.DeleteFile(ctx, other.FileID); err != nil {
						return err
					}
					if err := tx.DeleteOutbox(ctx, other.Path); err != nil {
						return err
					}
					adopted = &other
				} else {
					// A stale row (its file was replaced by the moved one): give it
					// a free name so the next scan reports it as gone.
					other.Path = uniquePath(np, func(p string) bool { _, used := byPath[p]; return used || e.diskExists(p) })
					byPath[other.Path] = other
					if err := tx.PutFile(ctx, other); err != nil {
						return err
					}
				}
				delete(byPath, np)
			}
			wasDeleted := r.State == StateLocalDeleted
			if r.State == StateLocalNew {
				r.Path = np
			} else {
				if r.MovedFrom == "" {
					r.MovedFrom = r.Path
				}
				r.Path = np
				switch r.State {
				case StateSynced:
					r.State = StateLocalMoved
				case StateLocalModify:
					r.State, r.Dirty = StateLocalMoved, true
				}
			}
			if adopted != nil {
				if adopted.LocalHash != r.LocalHash && r.State == StateLocalMoved {
					r.Dirty = true
				}
				r.LocalHash, r.LocalSize, r.LocalMtime = adopted.LocalHash, adopted.LocalSize, adopted.LocalMtime
				r.Attempts, r.LastError = 0, ""
			}
			if wasDeleted && (adopted != nil || e.diskExists(np)) {
				// The scan had marked the old path deleted, but the file lives on
				// at the new one. Whether its content still matches the server
				// cannot be told from a plaintext hash in a private vault (nor for
				// a file modified before it vanished), so it is sent again unless
				// provably equal.
				r.State = StateLocalMoved
				r.Dirty = e.cfg.Cipher != nil || r.LocalHash != r.ServerHash
			}
			if r.State == StateLocalMoved {
				r.Attempts, r.LastError = 0, "" // a new destination is a new attempt
				if r.MovedFrom == r.Path {
					settleMoved(&r) // moved back where the server has it (an edit stays to send)
				}
			}
			byPath[r.Path] = r
			if err := tx.PutFile(ctx, r); err != nil {
				return err
			}
		}
		return nil
	})
}

// loadPending reads the parked remote changes once per run (under e.run).
func (e *Engine) loadPending(ctx context.Context) error {
	if e.pendingLoaded {
		return nil
	}
	saved, err := e.cfg.DB.Pending(ctx)
	if err != nil {
		return err
	}
	for id, c := range saved {
		if cur, ok := e.candidates[id]; !ok || cur.Rev < c.Rev {
			e.candidates[id] = c
		}
	}
	e.pendingLoaded = true
	return nil
}

// addCandidate parks a remote change for resolution. It is saved to sync.db by
// saveCandidates, in the transaction that moves the cursor past it.
func (e *Engine) addCandidate(c transportChange) {
	if cur, ok := e.candidates[c.FileID]; ok && cur.Rev > c.Rev {
		return
	}
	e.candidates[c.FileID] = c
	e.staged[c.FileID] = true
}

// saveCandidates writes the staged candidates with db (a transaction or the
// plain database); call committed once db's writes are durable.
func (e *Engine) saveCandidates(ctx context.Context, db *DB) (committed func(), err error) {
	ids := make([]string, 0, len(e.staged))
	for id := range e.staged {
		c, ok := e.candidates[id]
		if !ok {
			continue
		}
		if err := db.PutPending(ctx, c, e.cfg.Now()); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return func() {
		for _, id := range ids {
			delete(e.staged, id)
		}
	}, nil
}

// dropCandidate forgets a candidate once it is settled.
func (e *Engine) dropCandidate(ctx context.Context, fileID string) error {
	if err := e.cfg.DB.DeletePending(ctx, fileID); err != nil {
		return err
	}
	delete(e.candidates, fileID)
	delete(e.staged, fileID)
	return nil
}

// isLocked reports whether err comes from a vault key that went away (the
// vault was locked, by the user or by the idle timeout, during the cycle).
func (e *Engine) isLocked(err error) bool {
	if errors.Is(err, ErrLocked) || errors.Is(err, crypto.ErrLocked) {
		return true
	}
	return e.cfg.Cipher != nil && e.cfg.Cipher.Locked()
}

// lockedErr turns a cipher failure caused by a locked vault into ErrLocked, so
// the cycle ends in PhaseLocked instead of treating the data as unreadable.
func (e *Engine) lockedErr(err error) error {
	if err == nil || errors.Is(err, ErrLocked) || !e.isLocked(err) {
		return err
	}
	return fmt.Errorf("%w: %w", ErrLocked, err)
}

func hashHex(data []byte) string { return hashing.Sum(data).Hex() }

// kindOf classifies a path.
func kindOf(path string) syncproto.FileKind { return syncproto.KindOf(path) }

func isNetwork(err error) bool {
	if err == nil {
		return false
	}
	var pe interface{ Timeout() bool }
	if errors.As(err, &pe) {
		return true
	}
	var ne interface{ Temporary() bool }
	if errors.As(err, &ne) {
		return true
	}
	s := err.Error()
	for _, frag := range []string{"connection refused", "no such host", "connection reset", "EOF", "i/o timeout", "network is unreachable", "dial tcp"} {
		if containsFold(s, frag) {
			return true
		}
	}
	return false
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}
