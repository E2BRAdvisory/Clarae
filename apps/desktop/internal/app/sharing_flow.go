package app

import (
	"context"
	"sync"
	"time"

	"clarae/apps/desktop/internal/auth"
)

// onSignedIn runs after a login: configuration first, then the mounts.
func (a *App) onSignedIn() {
	a.refreshConfigQuietly()
	a.requestReconcile()
}

// requestReconcile asks for a reconcile of the mounts (after a login, after every share event).
// The reconciles run one at a time: each one reads the server's list and then writes the mounts,
// so two at once could apply an older list after a newer one (a revoked mount brought back, a
// revocation announced twice). A burst of events while one runs is one more run.
func (a *App) requestReconcile() { a.reconciler.do(a.reconcileMounts) }

// coalescer runs a function on one goroutine at a time: a request while it runs queues one more
// run, and any number of requests during that run are that one run.
type coalescer struct {
	mu      sync.Mutex
	running bool
	queued  bool
}

func (c *coalescer) do(fn func()) {
	c.mu.Lock()
	if c.running {
		c.queued = true
		c.mu.Unlock()
		return
	}
	c.running = true
	c.mu.Unlock()
	go func() {
		for {
			fn()
			c.mu.Lock()
			if !c.queued {
				c.running = false
				c.mu.Unlock()
				return
			}
			c.queued = false
			c.mu.Unlock()
		}
	}()
}

func (a *App) refreshConfigQuietly() {
	if err := a.refreshConfig(a.ctx); err != nil {
		a.logger.Debug().Err(err).Msg("config refresh failed (the cached configuration stays)")
	}
}

// refreshConfig fetches the effective configuration and, when it changed, tells the UI.
func (a *App) refreshConfig(ctx context.Context) error {
	c := a.auth.Client()
	st := a.auth.State()
	if c == nil || st.ServerURL == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	changed, err := a.config.Refresh(ctx, st.ServerURL, c.GetEffectiveConfig)
	if err == nil && changed {
		a.applyConfig()
		EventConfigUpdated.Send(a.emit, a.configState())
	}
	return err
}

// reconcileMounts applies server-side changes of shares (new level, revocation) to the mounts
// here. Call it through requestReconcile. A mount that could not be updated is logged; the
// others are applied and announced all the same.
func (a *App) reconcileMounts() {
	if a.auth.State().Status != auth.StatusReady {
		return
	}
	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, 30*time.Second)
	defer cancel()
	n, err := a.sync.ReconcileMounts(ctx, a.mountsDir())
	if err != nil {
		a.logger.Warn().Err(err).Int("changed", n).Msg("mount reconcile failed")
	}
	if n > 0 {
		EventMountsChanged.Send(a.emit, MountsChangedPayload{Changed: n})
	}
}

// applyConfig hands the parts of the configuration the backend itself uses to their owners.
func (a *App) applyConfig() {
	cur := a.config.Current()
	secs, _ := configInt(cur.Config, "sync.interval_seconds")
	a.sync.SetManagedPoll(int(max(secs, 0)), keyLocked(cur.LockedKeys, "sync.interval_seconds"))
	maxFile, _ := configInt(cur.Config, "sync.max_file_size_bytes")
	a.sync.SetMaxFileBytes(max(maxFile, 0))
	mode, _ := configValue(cur.Config, "auth.redirect_mode")
	s, _ := mode.(string)
	a.auth.SetManagedRedirectMode(auth.ParseRedirectMode(s))
	a.sync.SetEnvelopeV2(envelopeV2Enabled(cur.Config))
	a.sync.SetPathV2(pathV2Enabled(cur.Config))
	a.sync.SetConfigDirV2(configDirV2Enabled(cur.Config))
	a.applyLockTimeout()
}
