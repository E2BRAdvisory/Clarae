package sync

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"memobrain/apps/desktop/internal/events"
	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/pathrules"
)

// A mount is a share received from another user (§2.6.4): a folder of its own on this
// device that syncs with the shared part of the owner's vault through the scope
// `share:{id}`. It is an ordinary vault for everything else (index, editor, search),
// which is how D-06 (no cross-vault features) comes for free.

// Meta keys of a mount in sync.db (besides the link keys of a vault).
const (
	MetaScope        = "scope"
	MetaPermission   = "permission"
	MetaShareID      = "share_id"
	MetaMountName    = "mount_name"
	MetaOwnerName    = "owner_name"
	MetaResourceType = "resource_type"
	MetaRevoked      = "revoked"
)

// EventMountRevoked tells the UI that the owner ended a share: the mount stopped syncing.
var EventMountRevoked = events.New[MountRevoked]("mount:revoked",
	"The share of a mount was revoked: the mount stopped syncing (a sync:status with the error follows).")

// MountRevoked is the payload of EventMountRevoked.
type MountRevoked struct {
	VaultID string `json:"vaultId"`
	ShareID string `json:"shareId"`
	// Name is the name of the mount.
	Name string `json:"name"`
}

// Permissions as the server names them; a vault of one's own has no share level.
const (
	PermViewer  = "viewer"
	PermEditor  = "editor"
	PermManager = "manager"
	PermOwner   = "owner"
)

// MountMeta is the link of a mount folder to a share.
type MountMeta struct {
	ShareID      string `json:"shareId"`
	CloudVaultID string `json:"cloudVaultId"`
	Scope        string `json:"scope"`
	Permission   string `json:"permission"`
	Name         string `json:"name"`
	OwnerName    string `json:"ownerName"`
	ResourceType string `json:"resourceType"`
	Revoked      bool   `json:"revoked"`
	// UserID and ServerURL are the account the mount was accepted with: a mount belongs to that
	// account on that server, and another sign-in leaves it alone (see belongsTo).
	UserID    string `json:"-"`
	ServerURL string `json:"-"`
}

// belongsTo reports whether the mount was made by the signed-in account on its server. After a
// switch of account (or of server) the shares of the first one are not the second one's to judge:
// they are neither revoked nor updated, and come back as they were when the first account signs
// in again. A link that recorded no account (none does today) is taken as the session's.
func (mm MountMeta) belongsTo(info SessionInfo) bool {
	return (mm.UserID == "" || mm.UserID == info.UserID) && (mm.ServerURL == "" || mm.ServerURL == info.ServerURL)
}

// MountOf converts the server's description of an accepted share.
func MountOf(m transport.Mount) MountMeta {
	return MountMeta{
		ShareID: m.ShareId.String(), CloudVaultID: m.VaultId.String(), Scope: m.Scope, Permission: string(m.Permission),
		Name: m.DisplayName, OwnerName: m.OwnerName, ResourceType: string(m.ResourceType),
	}
}

func openSyncDB(ctx context.Context, root string) (*DB, func(), error) {
	sdb, err := store.Open(ctx, filepath.Join(root, pathrules.ConfigDir, "sync.db"), store.KindSync)
	if err != nil {
		return nil, nil, err
	}
	return NewDB(sdb), func() { _ = sdb.Close() }, nil
}

// PrepareMount creates the folder of a mount and records its link, or refreshes the link
// of an existing one (name and level can change while the share lives). The vault is not
// open: the application opens the folder like any vault, and Attach starts the sync.
func PrepareMount(ctx context.Context, root string, m MountMeta, info SessionInfo) error {
	if err := os.MkdirAll(filepath.Join(root, pathrules.ConfigDir), 0o755); err != nil {
		return err
	}
	db, closeDB, err := openSyncDB(ctx, root)
	if err != nil {
		return err
	}
	defer closeDB()
	// One transaction: an interrupted refresh never leaves a link half old, half new.
	return db.WithTx(ctx, func(tx *DB) error {
		for k, v := range map[string]string{
			MetaCloudVault: m.CloudVaultID, MetaKind: "shared", MetaServerURL: info.ServerURL, MetaDeviceID: info.DeviceID,
			MetaUserID: info.UserID, MetaVaultName: m.Name, MetaScope: m.Scope, MetaPermission: m.Permission,
			MetaShareID: m.ShareID, MetaMountName: m.Name, MetaOwnerName: m.OwnerName, MetaResourceType: m.ResourceType,
		} {
			if err := tx.SetMeta(ctx, k, v); err != nil {
				return err
			}
		}
		if prev, _ := tx.Meta(ctx, MetaLinkedAt); prev == "" {
			if err := tx.SetMeta(ctx, MetaLinkedAt, time.Now().UTC().Format(time.RFC3339)); err != nil {
				return err
			}
		}
		return tx.DeleteMeta(ctx, MetaRevoked)
	})
}

// ReadMount reads the link of a mount folder; ok is false when the folder is not a mount.
func ReadMount(ctx context.Context, root string) (m MountMeta, ok bool, err error) {
	if exists, err := store.Exists(filepath.Join(root, pathrules.ConfigDir, "sync.db")); err != nil {
		return MountMeta{}, false, err
	} else if !exists {
		return MountMeta{}, false, nil
	}
	db, closeDB, err := openSyncDB(ctx, root)
	if err != nil {
		return MountMeta{}, false, err
	}
	defer closeDB()
	return readMountMeta(ctx, db)
}

func readMountMeta(ctx context.Context, db *DB) (MountMeta, bool, error) {
	scope, err := db.Meta(ctx, MetaScope)
	if err != nil || scope == "" {
		return MountMeta{}, false, err
	}
	get := func(k string) string { v, _ := db.Meta(ctx, k); return v }
	return MountMeta{
		ShareID: get(MetaShareID), CloudVaultID: get(MetaCloudVault), Scope: scope, Permission: get(MetaPermission),
		Name: get(MetaMountName), OwnerName: get(MetaOwnerName), ResourceType: get(MetaResourceType), Revoked: get(MetaRevoked) == "1",
		UserID: get(MetaUserID), ServerURL: get(MetaServerURL),
	}, true, nil
}

// ReadVaultName returns the name of the cloud vault a folder is linked to, or "" when it is not linked.
// The browser names its folders by cloud vault id, so the UI shows this name instead (ADR-0029).
func ReadVaultName(ctx context.Context, root string) string {
	if exists, err := store.Exists(filepath.Join(root, pathrules.ConfigDir, "sync.db")); err != nil || !exists {
		return ""
	}
	db, closeDB, err := openSyncDB(ctx, root)
	if err != nil {
		return ""
	}
	defer closeDB()
	name, _ := db.Meta(ctx, MetaVaultName)
	return name
}

// MountOfVault returns the mount link of an open vault.
func (m *Manager) MountOfVault(ctx context.Context, localID string) (MountMeta, bool) {
	mv, err := m.get(localID)
	if err != nil {
		return MountMeta{}, false
	}
	mm, ok, _ := readMountMeta(ctx, mv.db)
	return mm, ok
}

// Permission is the caller's level on an open vault: "owner" on a vault of their own that
// is connected to the cloud, the share level on a mount, "" otherwise (not connected: the
// folder is theirs, nothing restricts it).
func (m *Manager) Permission(ctx context.Context, localID string) string {
	mv, err := m.get(localID)
	if err != nil {
		return ""
	}
	m.mu.Lock()
	unlinked := mv.engine == nil && mv.cloudID == ""
	m.mu.Unlock()
	if unlinked {
		return ""
	}
	if mm, ok, _ := readMountMeta(ctx, mv.db); ok {
		return mm.Permission
	}
	return PermOwner
}

// ReadOnly reports whether the caller may not change this vault (viewer on a mount, or a
// mount whose share was revoked).
func (m *Manager) ReadOnly(ctx context.Context, localID string) bool {
	mm, ok := m.MountOfVault(ctx, localID)
	return ok && (mm.Revoked || mm.Permission == PermViewer)
}

// UpdateMount refreshes the level and name of an open mount (the server changed them) and
// restarts its engine with the new rights.
func (m *Manager) UpdateMount(ctx context.Context, localID string, mm MountMeta) error {
	mv, err := m.get(localID)
	if err != nil {
		return err
	}
	cur, ok, err := readMountMeta(ctx, mv.db)
	if err != nil || !ok {
		return fmt.Errorf("vault %s is not a mount", localID)
	}
	if cur.Permission == mm.Permission && cur.Name == mm.Name && !cur.Revoked {
		return nil
	}
	for k, v := range map[string]string{MetaPermission: mm.Permission, MetaMountName: mm.Name, MetaVaultName: mm.Name} {
		if err := mv.db.SetMeta(ctx, k, v); err != nil {
			return err
		}
	}
	_ = mv.db.DeleteMeta(ctx, MetaRevoked)
	return m.activate(ctx, mv) // stops the running engine and waits for it first
}

// markRevoked stops a mount whose share is gone and tells the UI.
func (m *Manager) markRevoked(ctx context.Context, mv *managed) {
	_ = mv.db.SetMeta(context.WithoutCancel(ctx), MetaRevoked, "1")
	m.mu.Lock()
	m.stopLocked(mv) // no wait: this may run on the loop itself, which returns right after
	m.mu.Unlock()
	name, _ := mv.db.Meta(context.WithoutCancel(ctx), MetaMountName)
	share, _ := mv.db.Meta(context.WithoutCancel(ctx), MetaShareID)
	EventMountRevoked.Send(m.emit, MountRevoked{VaultID: mv.localID, ShareID: share, Name: name})
	EventStatus.Send(m.emit, Status{VaultID: mv.localID, Phase: PhaseError, Kind: "shared", Error: "this share was revoked"})
}

// shareGone confirms that the share of a mount is gone after a cycle failed with a NOT_FOUND
// about the share itself (scopeNotFound: its tree or its changelog). The server answers so for a
// revoked, expired or deleted share, but also for a scope that is not the caller's: the mount must
// belong to the signed-in account, and the share must be missing from the account's mounts on the
// server. Anything that cannot be confirmed (offline, another account, the share still listed) is
// an ordinary error: the cycle is tried again later, nothing is marked.
func (m *Manager) shareGone(ctx context.Context, mv *managed) bool {
	mm, ok, err := readMountMeta(ctx, mv.db)
	if err != nil || !ok {
		return false
	}
	c, info, err := m.client()
	if err != nil || !mm.belongsTo(info) {
		return false
	}
	remote, err := c.SharedWithMe(ctx)
	if err != nil {
		return false
	}
	for _, r := range remote {
		if r.ShareId.String() == mm.ShareID {
			return false
		}
	}
	return true
}

// ForgetMount detaches a closed mount folder from its share: it keeps its files and becomes an
// ordinary folder (the "keep a detached copy" choice; the application then moves the folder out of
// the mounts directory).
func ForgetMount(ctx context.Context, root string) error {
	sdb, err := store.Open(ctx, filepath.Join(root, pathrules.ConfigDir, "sync.db"), store.KindSync)
	if err != nil {
		return err
	}
	defer func() { _ = sdb.Close() }()
	db := NewDB(sdb)
	for _, k := range []string{MetaCloudVault, MetaKind, MetaServerURL, MetaDeviceID, MetaUserID, MetaVaultName, MetaBootstrapped, MetaPaused, MetaLinkedAt, MetaLastScan, MetaScope, MetaPermission, MetaShareID, MetaMountName, MetaOwnerName, MetaResourceType, MetaRevoked} {
		_ = db.DeleteMeta(ctx, k)
	}
	_, err = sdb.ExecContext(ctx, resetSQL)
	return err
}

// MountVaultID returns the local id of the open vault that mounts a share ("" when it is not open).
func (m *Manager) MountVaultID(ctx context.Context, shareID string) string {
	return m.openMounts(ctx)[shareID]
}
