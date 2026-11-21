package app

import (
	"context"

	"clarae/apps/desktop/internal/presence"
)

// PresenceAPI is live presence on shared vaults (M25, ADR-0065): who else has the same file open, and
// where their cursor is. The same code runs on the desktop and in the browser core.
//
//   - Watch(vaultId, path) starts following a file and says whether it does: `watching` is false with a
//     `reason` (not-shared: the vault is private, not linked to the cloud or a revoked share;
//     not-synced: the file has no id on the server yet, ask again once it is synced; disabled: the
//     `presence` flag is off; offline: not signed in). Every Watch must be paired with an Unwatch (the
//     core counts, so two panels on one file are fine). The connection to the cloud is open only while a
//     file is watched, and stays 30 s after the last one.
//   - Move(vaultId, path, pos) says where the cursor of the user is. The core sends at most 25 frames a
//     second, the last position wins, and nothing when the position did not change.
//   - presence:members {vaultId, path, members} (the complete list of the others, never the own session or
//     another device of the same user), presence:move {vaultId, path, sid, pos} (coalesced) and
//     presence:cleared {vaultId, path} (connection lost, presence off, share revoked) report the rest.
//
// Presence is not saved and not audited. Capability: presence.
type PresenceAPI struct{ app *App }

// NewPresenceAPI binds the API.
func NewPresenceAPI(a *App) *PresenceAPI { return &PresenceAPI{app: a} }

// Watch starts following a file of a vault (see the type).
func (p *PresenceAPI) Watch(vaultID, path string) (presence.Watching, error) {
	return p.app.presence.Watch(context.Background(), vaultID, path), nil
}

// Unwatch undoes one Watch of the file.
func (p *PresenceAPI) Unwatch(vaultID, path string) error {
	p.app.presence.Unwatch(vaultID, path)
	return nil
}

// Move reports the position of the cursor in a watched file (kind "text": line and col; kind "scene": x and y).
func (p *PresenceAPI) Move(vaultID, path string, pos presence.Pos) error {
	return p.app.presence.Move(vaultID, path, pos)
}
