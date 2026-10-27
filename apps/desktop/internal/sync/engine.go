package sync

import (
	"context"
	"errors"
	"fmt"
	"strings"
	stdsync "sync"
	"time"

	"github.com/rs/zerolog"

	"nodus/apps/desktop/internal/vault"
	"nodus/shared/hashing"
	"nodus/shared/pathrules"
	"nodus/shared/syncproto"
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
	CacheDir string // where prepared ciphertext is kept (default <vault>/.nodus/cache/outbox)
	Logger   zerolog.Logger
	Now      func() time.Time
	// OnStatus and OnConflict receive updates (may be nil).
	OnStatus   func(Status)
	OnConflict func(Conflict)
}

// Engine synchronizes one vault. Sync calls are serialized.
type Engine struct {
	cfg Config
	log zerolog.Logger

	run stdsync.Mutex // one cycle at a time

	mu       stdsync.Mutex
	status   Status
	lastScan time.Time
	// candidates are remote changes that hit a locally modified file; they
	// are resolved after the pull completed (§3.4.4 B).
	candidates map[string]transportChange
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
	e := &Engine{cfg: cfg, log: cfg.Logger, candidates: map[string]transportChange{}}
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
	if !e.tmpCleaned {
		// Staging files of a write that crashed are never synced (pathrules); remove them once.
		e.tmpCleaned = true
		if n, err := e.cfg.FS.CleanStaleTemp(time.Minute); err == nil && n > 0 {
			e.log.Info().Int("files", n).Msg("removed stale temporary files of interrupted writes")
		}
	}
	for round := 0; round < 6; round++ {
		if err := e.scan(ctx); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		pulled, err := e.pull(ctx)
		if err != nil {
			return fmt.Errorf("pull: %w", err)
		}
		resolved, err := e.resolveCandidates(ctx)
		if err != nil {
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
			return nil
		}
		e.mu.Lock()
		e.active = true
		e.mu.Unlock()
	}
	return nil
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
func (e *Engine) Renamed(ctx context.Context, from, to string) error {
	e.run.Lock()
	defer e.run.Unlock()
	rows, err := e.cfg.DB.Files(ctx)
	if err != nil {
		return err
	}
	for _, r := range rows {
		var np string
		switch {
		case r.Path == from:
			np = to
		case pathrules.HasPrefix(r.Path, from):
			np = to + r.Path[len(from):]
		default:
			continue
		}
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
		if err := e.cfg.DB.PutFile(ctx, r); err != nil {
			return err
		}
	}
	return nil
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
