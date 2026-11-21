package sync

import "context"

// Reasons PresenceTarget gives for a file that has no room.
const (
	// PresenceNotShared: the vault is private, not linked, or a mount that was revoked.
	PresenceNotShared = "not-shared"
	// PresenceNotSynced: the file has no id on the server yet (never uploaded, or deleted).
	PresenceNotSynced = "not-synced"
)

// PresenceTarget maps a file of a local vault to its room on the server: the cloud vault id and the
// file id (the UUID of the server, the same for the owner and for the mount of a folder or a file:
// the path is relative to the mount, as in sync.db). reason is "" when there is a room. Only shared
// vaults have presence (D-02): a private vault and a vault that is not linked never do.
func (m *Manager) PresenceTarget(ctx context.Context, localID, path string) (cloudVaultID, fileID, reason string) {
	mv, err := m.linked(localID)
	if err != nil || mv.kind != "shared" || mv.cloudID == "" {
		return "", "", PresenceNotShared
	}
	if mm, ok, _ := readMountMeta(ctx, mv.db); ok && mm.Revoked {
		return "", "", PresenceNotShared
	}
	row, ok, err := mv.db.GetFile(ctx, path)
	if err != nil || !ok || row.FileID == "" || row.Tombstoned {
		return "", "", PresenceNotSynced
	}
	return mv.cloudID, row.FileID, ""
}
