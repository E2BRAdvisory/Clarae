package app

import (
	"context"

	"memobrain/apps/desktop/internal/history"
)

// HistoryAPI exposes the device-local file history ("File recovery"): snapshots of text files,
// restore, and the list of deleted files that can be recovered. Cloud revisions are served by
// SyncAPI.History; the frontend shows both in one view.
type HistoryAPI struct{ app *App }

// NewHistoryAPI binds the API.
func NewHistoryAPI(a *App) *HistoryAPI { return &HistoryAPI{app: a} }

func (h *HistoryAPI) store(vaultID string) (*history.History, error) {
	ov, err := h.app.vault(vaultID)
	if err != nil {
		return nil, err
	}
	return ov.History, nil
}

// List returns the snapshots of a note, newest first.
func (h *HistoryAPI) List(vaultID, relPath string) ([]history.Snapshot, error) {
	s, err := h.store(vaultID)
	if err != nil {
		return nil, err
	}
	return s.List(relPath)
}

// Read returns the text of a snapshot.
func (h *HistoryAPI) Read(vaultID, snapshotID string) (history.Content, error) {
	s, err := h.store(vaultID)
	if err != nil {
		return history.Content{}, err
	}
	return s.Read(snapshotID)
}

// Restore writes a snapshot back over its note (recreating a deleted one). The current version
// is snapshotted first, so nothing is lost. Refused on read-only vaults.
func (h *HistoryAPI) Restore(vaultID, snapshotID string) (WriteResult, error) {
	if err := h.app.writable(vaultID); err != nil {
		return WriteResult{}, err
	}
	ov, err := h.app.vault(vaultID)
	if err != nil {
		return WriteResult{}, err
	}
	path, hash, err := ov.History.Restore(snapshotID)
	if err != nil {
		return WriteResult{}, bindingError(err)
	}
	changes := classifyChanges(context.Background(), ov, []string{path})
	_ = ov.Indexer.Update(context.Background(), []string{path})
	EventVaultFileChanged.Send(h.app.emit, FileChangedPayload{VaultID: vaultID, Paths: []string{path}, Changes: changes})
	h.app.sync.Kick(vaultID)
	return WriteResult{Path: path, Hash: hash}, nil
}

// ListDeleted returns the files that no longer exist but have snapshots, newest first.
func (h *HistoryAPI) ListDeleted(vaultID string) ([]history.Deleted, error) {
	s, err := h.store(vaultID)
	if err != nil {
		return nil, err
	}
	return s.ListDeleted()
}

// GetSettings returns the snapshot interval, retention and size caps of the vault.
func (h *HistoryAPI) GetSettings(vaultID string) (history.Settings, error) {
	s, err := h.store(vaultID)
	if err != nil {
		return history.Settings{}, err
	}
	return s.Settings(), nil
}

// SetSettings validates and saves the history settings (out-of-range values are clamped).
func (h *HistoryAPI) SetSettings(vaultID string, st history.Settings) (history.Settings, error) {
	if err := h.app.writable(vaultID); err != nil {
		return history.Settings{}, err
	}
	s, err := h.store(vaultID)
	if err != nil {
		return history.Settings{}, err
	}
	return s.SetSettings(st)
}
