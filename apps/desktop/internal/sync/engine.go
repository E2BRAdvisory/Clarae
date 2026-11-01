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
}

// ErrLocked means the private vault must be unlocked before it can sync.
var ErrLocked = errors.New("vault is locked")

// ErrPaused means synchronization is paused for this vault.
var ErrPaused = errors.New("synchronization is paused")

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
}

// Engine synchronizes one vault. Sync calls are serialized.
type Engine struct {
	cfg Config
	log zerolog.Logger

	run stdsync.Mutex // one cycle at a time

	mu     stdsync.Mutex
	status Status
	// lastScan is when the last complete scan started (see scan); it is kept
	// in sync.db so the first scan after a restart trusts the same files a
	// later scan would. scanLoaded: it was read from sync.db (under e.run).
	lastScan   time.Time
	scanLoaded bool
	// hashFile hashes a vault file (FS.HashFile; replaced by tests to count reads).
	hashFile func(rel string) (string, int64, error)
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
}

// New creates the engine.
func New(cfg Config) *Engine {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.CacheDir == "" {
		cfg.CacheDir = cfg.FS.Root() + "/" + pathrules.ConfigDir + "/cache/outbox"
	}
	e := &Engine{cfg: cfg, log: cfg.Logger, candidates: map[string]transportChange{}, staged: map[string]bool{}, hashFile: cfg.FS.HashFile}
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

func (e *Engine) progress(done, total int) {
	e.setStatus(func(s *Status) { s.Done, s.Total = done, total })
}

// Sync runs reconciliation rounds until nothing is left to do (or the round
// limit is reached): scan local changes, pull, resolve, push.
func (e *Engine) Sync(ctx context.Context) (err error) {
	e.run.Lock()
	defer e.run.Unlock()

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
		e.setStatus(func(s *Status) {
			s.Pending, s.Conflicts = pending, conflicts
			s.Done, s.Total = 0, 0
			switch {
			case err == nil:
				s.Phase, s.LastSync, s.Error = PhaseIdle, e.cfg.Now(), ""
			case errors.Is(err, ErrLocked):
				s.Phase, s.Error = PhaseLocked, ""
			case errors.Is(err, context.Canceled):
				s.Phase = PhaseIdle
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
		if err := e.scan(ctx); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		pulled, err := e.pull(ctx)
		if err != nil {
			return fmt.Errorf("pull: %w", err)
		}
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
func (e *Engine) Exclusive(fn func() error) error {
	e.run.Lock()
	defer e.run.Unlock()
	return fn()
}

// Renamed tells the engine that a file or folder moved so identity survives
// even if the move also rewrote content (link updates): without this hint a
// renamed-and-edited note would look like a delete plus a new file (§3.4.4 A).
// A scan that ran between the move and the hint may already have recorded the
// new path as a new file (and the old one as deleted): the two rows are merged
// back into the original identity. Everything happens in one transaction.
func (e *Engine) Renamed(ctx context.Context, from, to string) error {
	e.run.Lock()
	defer e.run.Unlock()
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
