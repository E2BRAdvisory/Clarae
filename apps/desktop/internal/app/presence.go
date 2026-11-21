package app

import (
	"context"
	"time"

	"clarae/apps/desktop/internal/presence"
	"clarae/apps/desktop/internal/sync/transport"
	flags "clarae/shared/features"
)

// initPresence builds the presence hub (M25, ADR-0065). It runs in the browser core too: the
// WebSocket is the one of the page, the rest is the same code.
func (a *App) initPresence() {
	a.presence = presence.NewHub(presence.Options{
		Client:  func() *transport.Client { return a.auth.Client() },
		UserID:  func() string { return a.auth.State().Profile.UserID },
		Enabled: func() bool { return flags.Enabled(a.config.Current().Config, flags.Presence) },
		Resolve: func(ctx context.Context, vaultID, path string) (string, string, string) {
			return a.sync.PresenceTarget(ctx, vaultID, path)
		},
		Emit: a.emit,
		Log:  a.logger.With().Str("module", "presence").Logger(),
	})
}

// refreshPresence tells the hub that the session, the shares or the configuration changed. It runs
// on a goroutine of its own: the callers hold locks of the session or of the sync manager.
func (a *App) refreshPresence() {
	if a.presence == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		a.presence.Refresh(ctx)
	}()
}
