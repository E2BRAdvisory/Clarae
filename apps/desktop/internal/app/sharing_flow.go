package app

import (
	"context"
	"time"

	"memobrain/apps/desktop/internal/auth"
)

// Event the sharing flow adds to the application's set (config:updated, with the new
// ConfigState, is declared in events.go).
const (
	// EventMountsChanged says that mount levels or availability changed on this device.
	EventMountsChanged = "mounts:changed"
)

// onSignedIn runs after a login: configuration first, then the mounts.
func (a *App) onSignedIn() {
	a.refreshConfigQuietly()
	a.reconcileMounts()
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
		a.emit(EventConfigUpdated, a.configState())
	}
	return err
}

// reconcileMounts applies server-side changes of shares (new level, revocation) to the mounts here.
func (a *App) reconcileMounts() {
	if a.auth.State().Status != auth.StatusReady {
		return
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	n, err := a.sync.ReconcileMounts(ctx, a.mountsDir())
	if err != nil {
		a.logger.Debug().Err(err).Msg("mount reconcile failed")
		return
	}
	if n > 0 {
		a.emit(EventMountsChanged, map[string]any{"changed": n})
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
	a.applyLockTimeout()
}
