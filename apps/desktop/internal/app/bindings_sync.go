package app

import (
	"context"

	"memobrain/apps/desktop/internal/app/cloudapi"
	"memobrain/apps/desktop/internal/crypto"
	syncpkg "memobrain/apps/desktop/internal/sync"
)

// ConflictTexts are the two versions shown side by side.
type ConflictTexts struct {
	Current string `json:"current"` // what the path holds now (the server version)
	Ours    string `json:"ours"`    // what this device had (the saved copy)
	// CurrentHash is the digest of Current: keep-local and merged replace the
	// file only while it still holds that content.
	CurrentHash string `json:"currentHash"`
}

// SyncAPI exposes synchronization to the frontend (§2.5 "sync"). Status and
// conflicts also arrive as sync:status and sync:conflict events.
type SyncAPI struct{ app *App }

// NewSyncAPI binds the API.
func NewSyncAPI(a *App) *SyncAPI { return &SyncAPI{app: a} }

// Info describes the cloud connection of a vault.
func (s *SyncAPI) Info(vaultID string) (syncpkg.LinkInfo, error) {
	return s.app.sync.Info(context.Background(), vaultID)
}

// Status returns the synchronization status of a vault.
func (s *SyncAPI) Status(vaultID string) (syncpkg.Status, error) {
	return s.app.sync.Status(context.Background(), vaultID)
}

// LinkNew creates a cloud vault ("shared" or "private") for the open vault and
// starts the first upload. Private vaults need a passphrase (min. 12 characters)
// and return the recovery key, shown once.
func (s *SyncAPI) LinkNew(vaultID, name, kind, passphrase string) (syncpkg.LinkResult, error) {
	r, err := s.app.sync.Link(context.Background(), vaultID, name, kind, passphrase)
	return r, bindingError(err)
}

// ListCloudVaults lists the account's vaults (the cloud-management bindings return the types of
// the OpenAPI, ADR-0045 §6).
func (s *SyncAPI) ListCloudVaults() ([]cloudapi.Vault, error) {
	vs, err := s.app.sync.CloudVaults(context.Background())
	if err != nil {
		return nil, bindingError(err)
	}
	return cloudapi.VaultsOf(vs), nil
}

// ListDeletedCloudVaults lists the account's soft-deleted vaults that can still
// be restored (deleted within the server's retention period).
func (s *SyncAPI) ListDeletedCloudVaults() ([]cloudapi.Vault, error) {
	vs, err := s.app.sync.DeletedCloudVaults(context.Background())
	if err != nil {
		return nil, bindingError(err)
	}
	return cloudapi.VaultsOf(vs), nil
}

// RenameCloudVault renames a cloud vault of the account. A vault of this
// device linked to it shows the new name in its link; folders keep theirs.
func (s *SyncAPI) RenameCloudVault(cloudVaultID, name string) (cloudapi.Vault, error) {
	v, err := s.app.sync.RenameCloudVault(context.Background(), cloudVaultID, name)
	if err != nil {
		return cloudapi.Vault{}, bindingError(err)
	}
	return cloudapi.VaultOf(v), nil
}

// DeleteCloudVault soft-deletes a cloud vault of the account (restorable within
// the retention period). The vaults of this device linked to it are then
// disconnected: their files stay on disk.
func (s *SyncAPI) DeleteCloudVault(cloudVaultID string) error {
	_, err := s.app.sync.DeleteCloudVault(context.Background(), cloudVaultID)
	return bindingError(err)
}

// RestoreCloudVault restores a soft-deleted cloud vault within the retention period.
func (s *SyncAPI) RestoreCloudVault(cloudVaultID string) (cloudapi.Vault, error) {
	v, err := s.app.sync.RestoreCloudVault(context.Background(), cloudVaultID)
	if err != nil {
		return cloudapi.Vault{}, bindingError(err)
	}
	return cloudapi.VaultOf(v), nil
}

// LinkExisting connects the open vault to an existing cloud vault (a new device).
func (s *SyncAPI) LinkExisting(vaultID, cloudVaultID string) error {
	return bindingError(s.app.sync.LinkExisting(context.Background(), vaultID, cloudVaultID))
}

// Unlink disconnects the vault from the cloud; local files are kept.
func (s *SyncAPI) Unlink(vaultID string) error {
	return bindingError(s.app.sync.Unlink(context.Background(), vaultID))
}

// SetPaused pauses or resumes synchronization of a vault.
func (s *SyncAPI) SetPaused(vaultID string, paused bool) error {
	return bindingError(s.app.sync.SetPaused(context.Background(), vaultID, paused))
}

// SetPollInterval sets the polling interval in seconds (0 = automatic, minimum 15).
func (s *SyncAPI) SetPollInterval(vaultID string, seconds int) error {
	return bindingError(s.app.sync.SetPollInterval(context.Background(), vaultID, seconds))
}

// SyncNow asks for an immediate synchronization.
func (s *SyncAPI) SyncNow(vaultID string) error { return bindingError(s.app.sync.SyncNow(vaultID)) }

// Conflicts lists the unresolved conflicts of a vault.
func (s *SyncAPI) Conflicts(vaultID string) ([]syncpkg.Conflict, error) {
	c, err := s.app.sync.Conflicts(context.Background(), vaultID)
	if c == nil {
		c = []syncpkg.Conflict{}
	}
	return c, bindingError(err)
}

// ConflictTexts returns both versions of a conflict.
func (s *SyncAPI) ConflictTexts(vaultID string, id int64) (ConflictTexts, error) {
	v, err := s.app.sync.ConflictTexts(context.Background(), vaultID, id)
	return ConflictTexts{Current: v.Current, Ours: v.Ours, CurrentHash: v.CurrentHash}, bindingError(err)
}

// ResolveConflict settles a conflict: action is "keep-remote", "keep-local",
// "keep-both" or "merged" (merged carries the text the user composed).
// keep-local and merged replace the file only while it holds the version the
// last ConflictTexts showed; otherwise they fail with a conflict error and
// the view must be loaded again.
func (s *SyncAPI) ResolveConflict(vaultID string, id int64, action, merged string) error {
	return bindingError(s.app.sync.ResolveConflict(context.Background(), vaultID, id, syncpkg.ConflictAction(action), merged, ""))
}

// History lists the revisions of a note, newest first.
func (s *SyncAPI) History(vaultID, relPath string) ([]syncpkg.RevisionInfo, error) {
	h, err := s.app.sync.History(context.Background(), vaultID, relPath)
	if h == nil {
		h = []syncpkg.RevisionInfo{}
	}
	return h, bindingError(err)
}

// RevisionText returns the text of one revision (decrypted on this device for private vaults).
func (s *SyncAPI) RevisionText(vaultID, relPath string, rev int) (string, error) {
	t, err := s.app.sync.RevisionText(context.Background(), vaultID, relPath, rev)
	return t, bindingError(err)
}

// RestoreRevision restores a revision as a new one.
func (s *SyncAPI) RestoreRevision(vaultID, relPath string, rev int) error {
	return bindingError(s.app.sync.RestoreRevision(context.Background(), vaultID, relPath, rev))
}

// Devices lists the devices of the account; `current` marks the device the core runs on.
func (s *SyncAPI) Devices() ([]cloudapi.AccountDevice, error) {
	ds, err := s.app.sync.Devices(context.Background())
	if err != nil {
		return nil, bindingError(err)
	}
	return cloudapi.DevicesOf(ds, s.app.auth.State().DeviceID), nil
}

// RevokeDevice revokes a device of the account.
func (s *SyncAPI) RevokeDevice(id string) error {
	return bindingError(s.app.sync.RevokeDevice(context.Background(), id))
}

// Usage returns the storage usage of the account.
func (s *SyncAPI) Usage() (cloudapi.Usage, error) {
	u, err := s.app.sync.Usage(context.Background())
	if err != nil {
		return cloudapi.Usage{}, bindingError(err)
	}
	return cloudapi.UsageOf(u), nil
}

// VaultCryptoAPI exposes end-to-end encryption of private vaults (§2.5).
type VaultCryptoAPI struct{ app *App }

// NewVaultCryptoAPI binds the API.
func NewVaultCryptoAPI(a *App) *VaultCryptoAPI { return &VaultCryptoAPI{app: a} }

// Unlock opens a private vault with its passphrase or, when isRecovery is
// true, its recovery key. The result is true when the caller must now ask for
// a new passphrase and call SetPassphrase (recovery flow).
func (c *VaultCryptoAPI) Unlock(vaultID, secret string, isRecovery bool) (bool, error) {
	r, err := c.app.sync.Unlock(context.Background(), vaultID, secret, isRecovery)
	return r, bindingError(err)
}

// Lock forgets the vault key on this device.
func (c *VaultCryptoAPI) Lock(vaultID string) error {
	return bindingError(c.app.sync.LockVault(context.Background(), vaultID))
}

// Activity tells the core that the user is active (pointer, keys, scrolling):
// the idle timer of the unlocked private vaults starts again. The page calls
// it at most every few seconds; background synchronization never counts.
func (c *VaultCryptoAPI) Activity() {
	c.app.sync.Activity()
}

// SetPassphrase sets a new passphrase on an unlocked vault (after a recovery).
func (c *VaultCryptoAPI) SetPassphrase(vaultID, newPassphrase string) error {
	return bindingError(c.app.sync.SetPassphrase(context.Background(), vaultID, newPassphrase))
}

// ChangePassphrase replaces the passphrase after checking the old one.
func (c *VaultCryptoAPI) ChangePassphrase(vaultID, oldPassphrase, newPassphrase string) error {
	return bindingError(c.app.sync.ChangePassphrase(context.Background(), vaultID, oldPassphrase, newPassphrase))
}

// RegenerateRecoveryKey issues a new recovery key (shown once); the old one stops working.
func (c *VaultCryptoAPI) RegenerateRecoveryKey(vaultID, passphrase string) (string, error) {
	k, err := c.app.sync.RegenerateRecoveryKey(context.Background(), vaultID, passphrase)
	return k, bindingError(err)
}

// DiskEncryption reports whether the system disk looks encrypted: "encrypted",
// "unencrypted" or "unknown" (the vault copy on disk is in clear text, §3.8.6).
func (c *VaultCryptoAPI) DiskEncryption() string {
	return string(crypto.CheckDiskEncryption(context.Background()))
}
