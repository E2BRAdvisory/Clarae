package sync

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/apiclient"
	"memobrain/shared/syncproto"
)

// MountState is a share received by the user, with what this device knows about it.
type MountState struct {
	ShareID      string `json:"shareId"`
	CloudVaultID string `json:"cloudVaultId"`
	Name         string `json:"name"`
	OwnerName    string `json:"ownerName"`
	ResourceType string `json:"resourceType"`
	Permission   string `json:"permission"`
	// Path is the folder of the mount on this device ("" until it is created).
	Path string `json:"path"`
	// Mounted is true once the folder exists; Revoked when the share is gone but the copy is still here.
	Mounted bool `json:"mounted"`
	Revoked bool `json:"revoked"`
	// VaultID is the local id of the mount when it is open.
	VaultID string `json:"vaultId"`
}

// MountDir is the folder of a share's mount under the mounts directory.
func MountDir(mountsDir, shareID string) string { return filepath.Join(mountsDir, shareID) }

// Invitations returns the shares waiting for the user's answer.
func (m *Manager) Invitations(ctx context.Context) ([]transport.Share, error) {
	c, _, err := m.client()
	if err != nil {
		return nil, err
	}
	all, err := c.ListShares(ctx, "received")
	if err != nil {
		return nil, err
	}
	out := make([]transport.Share, 0, len(all))
	for _, s := range all {
		if s.MyStatus != nil && *s.MyStatus == apiclient.GrantStatusPending {
			out = append(out, s)
		}
	}
	return out, nil
}

// Mounts lists the accepted shares and, for each, the state of its folder.
func (m *Manager) Mounts(ctx context.Context, mountsDir string) ([]MountState, error) {
	c, _, err := m.client()
	if err != nil {
		return nil, err
	}
	remote, err := c.SharedWithMe(ctx)
	if err != nil {
		return nil, err
	}
	open := m.openMounts(ctx)
	out := make([]MountState, 0, len(remote))
	seen := map[string]bool{}
	for _, r := range remote {
		mm := MountOf(r)
		seen[mm.ShareID] = true
		st := MountState{
			ShareID: mm.ShareID, CloudVaultID: mm.CloudVaultID, Name: mm.Name, OwnerName: mm.OwnerName,
			ResourceType: mm.ResourceType, Permission: mm.Permission,
		}
		dir := MountDir(mountsDir, mm.ShareID)
		if _, err := os.Stat(dir); err == nil {
			st.Path, st.Mounted = dir, true
		}
		st.VaultID = open[mm.ShareID]
		out = append(out, st)
	}
	// Mount folders whose share is gone (revoked, expired, deleted): still on disk until the user decides.
	entries, _ := os.ReadDir(mountsDir)
	for _, e := range entries {
		if !e.IsDir() || seen[e.Name()] {
			continue
		}
		mm, ok, err := ReadMount(ctx, filepath.Join(mountsDir, e.Name()))
		if err != nil || !ok {
			continue
		}
		out = append(out, MountState{
			ShareID: mm.ShareID, CloudVaultID: mm.CloudVaultID, Name: mm.Name, OwnerName: mm.OwnerName, ResourceType: mm.ResourceType,
			Permission: mm.Permission, Path: filepath.Join(mountsDir, e.Name()), Mounted: true, Revoked: true, VaultID: open[mm.ShareID],
		})
	}
	return out, nil
}

// openMounts maps share id to local vault id for the mounts that are open.
func (m *Manager) openMounts(ctx context.Context) map[string]string {
	m.mu.Lock()
	vs := make([]*managed, 0, len(m.vaults))
	for _, v := range m.vaults {
		vs = append(vs, v)
	}
	m.mu.Unlock()
	out := map[string]string{}
	for _, v := range vs {
		if mm, ok, _ := readMountMeta(ctx, v.db); ok {
			out[mm.ShareID] = v.localID
		}
	}
	return out
}

// AcceptShare accepts an invitation and creates the folder of its mount.
func (m *Manager) AcceptShare(ctx context.Context, shareID, mountsDir string) (MountState, error) {
	c, info, err := m.client()
	if err != nil {
		return MountState{}, err
	}
	if _, err := c.AcceptShare(ctx, shareID); err != nil {
		return MountState{}, err
	}
	remote, err := c.SharedWithMe(ctx)
	if err != nil {
		return MountState{}, err
	}
	for _, r := range remote {
		mm := MountOf(r)
		if mm.ShareID != shareID {
			continue
		}
		dir := MountDir(mountsDir, shareID)
		if err := PrepareMount(ctx, dir, mm, info); err != nil {
			return MountState{}, err
		}
		return MountState{
			ShareID: mm.ShareID, CloudVaultID: mm.CloudVaultID, Name: mm.Name, OwnerName: mm.OwnerName,
			ResourceType: mm.ResourceType, Permission: mm.Permission, Path: dir, Mounted: true,
		}, nil
	}
	return MountState{}, fmt.Errorf("the share %s was accepted but is not listed as a mount", shareID)
}

// DeclineShare declines an invitation.
func (m *Manager) DeclineShare(ctx context.Context, shareID string) error {
	c, _, err := m.client()
	if err != nil {
		return err
	}
	_, err = c.DeclineShare(ctx, shareID)
	return err
}

// EnsureMount creates (or refreshes) the folder of an accepted share and returns its path.
func (m *Manager) EnsureMount(ctx context.Context, shareID, mountsDir string) (string, error) {
	c, info, err := m.client()
	if err != nil {
		return "", err
	}
	remote, err := c.SharedWithMe(ctx)
	if err != nil {
		return "", err
	}
	for _, r := range remote {
		if mm := MountOf(r); mm.ShareID == shareID {
			dir := MountDir(mountsDir, shareID)
			return dir, PrepareMount(ctx, dir, mm, info)
		}
	}
	return "", errors.New("this share is not available any more")
}

// ReconcileMounts aligns the mounts on this device with the server after share events: new
// levels and names are applied, mounts of shares that are gone are marked revoked. It
// returns the number of mounts that changed.
func (m *Manager) ReconcileMounts(ctx context.Context, mountsDir string) (int, error) {
	c, info, err := m.client()
	if err != nil {
		return 0, err
	}
	remote, err := c.SharedWithMe(ctx)
	if err != nil {
		return 0, err
	}
	byShare := make(map[string]MountMeta, len(remote))
	for _, r := range remote {
		mm := MountOf(r)
		byShare[mm.ShareID] = mm
	}
	open := m.openMounts(ctx)
	entries, _ := os.ReadDir(mountsDir)
	changed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(mountsDir, e.Name())
		local := open[e.Name()]
		r, live := byShare[e.Name()]
		if local != "" {
			mv, err := m.get(local)
			if err != nil {
				continue
			}
			cur, ok, _ := readMountMeta(ctx, mv.db)
			if !ok {
				continue
			}
			switch {
			case live && (cur.Permission != r.Permission || cur.Name != r.Name || cur.Revoked):
				if err := m.UpdateMount(ctx, local, r); err == nil {
					changed++
				}
			case !live && !cur.Revoked:
				m.markRevoked(ctx, mv)
				changed++
			}
			continue
		}
		// A closed mount: edit its sync.db directly.
		cur, ok, err := ReadMount(ctx, dir)
		if err != nil || !ok {
			continue
		}
		switch {
		case live && (cur.Permission != r.Permission || cur.Name != r.Name || cur.Revoked):
			if PrepareMount(ctx, dir, r, info) == nil {
				changed++
			}
		case !live && !cur.Revoked:
			if db, closeDB, err := openSyncDB(ctx, dir); err == nil {
				_ = db.SetMeta(ctx, MetaRevoked, "1")
				closeDB()
				changed++
			}
		}
	}
	return changed, nil
}

// DetachMount turns a mount into an ordinary folder: it stops syncing, keeps its files and
// forgets the share (the "keep a detached copy" choice after a revocation). The vault, if open,
// stays open as a plain local one.
func (m *Manager) DetachMount(ctx context.Context, localID string) error {
	return m.Unlink(ctx, localID)
}

// --- sharing a folder or a document of one's own vault -------------------------

// ShareTarget is what a folder or document of a connected vault maps to on the server.
type ShareTarget struct {
	CloudVaultID string
	ResourceType string // folder | file | vault
	PathPrefix   string
	FileID       string
}

// TargetOf resolves a path of a connected, shared, owned vault to what the server can share.
// An empty path with isDir shares the whole vault. A document must have been synchronized once.
func (m *Manager) TargetOf(ctx context.Context, localID, path string, isDir bool) (ShareTarget, error) {
	mv, err := m.linked(localID)
	if err != nil {
		return ShareTarget{}, err
	}
	if _, ok, _ := readMountMeta(ctx, mv.db); ok {
		return ShareTarget{}, errors.New("a shared folder received from someone else cannot be shared again")
	}
	if mv.kind != "shared" {
		return ShareTarget{}, errors.New("only shared (not end-to-end encrypted) vaults can be shared")
	}
	t := ShareTarget{CloudVaultID: mv.cloudID}
	switch {
	case isDir && strings.Trim(path, "/") == "":
		t.ResourceType = "vault"
	case isDir:
		t.ResourceType, t.PathPrefix = "folder", strings.Trim(path, "/")
	default:
		row, ok, err := mv.db.GetFile(ctx, path)
		if err != nil {
			return ShareTarget{}, err
		}
		if !ok || row.ServerRev == 0 {
			return ShareTarget{}, errors.New("this document has not been synchronized yet: try again in a moment")
		}
		t.ResourceType, t.FileID = "file", row.FileID
	}
	return t, nil
}

// CreateShare shares a folder, a document or the whole of a connected vault.
func (m *Manager) CreateShare(ctx context.Context, localID, path string, isDir bool, name string, grants []transport.NewGrant, expires *time.Time) (transport.Share, error) {
	t, err := m.TargetOf(ctx, localID, path, isDir)
	if err != nil {
		return transport.Share{}, err
	}
	c, _, err := m.client()
	if err != nil {
		return transport.Share{}, err
	}
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(path)
		if name == "." || name == "/" || name == "" {
			name = "Shared"
		}
	}
	vaultID, err := uuid.Parse(t.CloudVaultID)
	if err != nil {
		return transport.Share{}, fmt.Errorf("cloud vault id: %w", err)
	}
	in := transport.CreateShare{VaultId: vaultID, ResourceType: apiclient.ResourceType(t.ResourceType), DisplayName: name, ExpiresAt: expires}
	if t.PathPrefix != "" {
		in.PathPrefix = &t.PathPrefix
	}
	if t.FileID != "" {
		fileID, err := uuid.Parse(t.FileID)
		if err != nil {
			return transport.Share{}, fmt.Errorf("file id: %w", err)
		}
		in.FileId = &fileID
	}
	if len(grants) > 0 {
		in.Grants = &grants
	}
	return c.CreateShare(ctx, in)
}

// VaultShares lists the shares of the connected vault's cloud copy that the caller owns.
func (m *Manager) VaultShares(ctx context.Context, localID string) ([]transport.Share, error) {
	mv, err := m.linked(localID)
	if err != nil {
		return nil, err
	}
	c, _, err := m.client()
	if err != nil {
		return nil, err
	}
	all, err := c.ListShares(ctx, "owned")
	if err != nil {
		return nil, err
	}
	out := make([]transport.Share, 0, len(all))
	for _, s := range all {
		if s.VaultId.String() == mv.cloudID {
			out = append(out, s)
		}
	}
	return out, nil
}

// IsNotFound reports whether err is the server's NOT_FOUND.
func IsNotFound(err error) bool { return transport.IsCode(err, syncproto.CodeNotFound) }

// --- account-wide share management (@memobrain/cloud-features, ADR-0037 §2) -----

// ListShares returns the shares the caller owns or manages ("owned") or was invited to
// ("received"), across every vault of the account.
func (m *Manager) ListShares(ctx context.Context, scope string) ([]transport.Share, error) {
	if scope != "owned" && scope != "received" {
		return nil, fmt.Errorf("invalid: share scope %q (owned or received)", scope)
	}
	c, _, err := m.client()
	if err != nil {
		return nil, err
	}
	return c.ListShares(ctx, scope)
}

// CreateCloudShare shares a whole cloud vault (empty pathPrefix) or one of its folders, by cloud
// vault id: the account-wide "New share" of the settings and of the console, which need no local
// copy. The caller is the owner of the vault or a manager of a share of it (ADR-0041 §8), who
// shares only inside that share: the server decides, this side does not check ownership. A private
// vault is never shareable (D-02): when the vault is the caller's and private, the server is not
// asked; a vault that is not the caller's (NOT_FOUND here) is left to the server.
func (m *Manager) CreateCloudShare(ctx context.Context, cloudVaultID, pathPrefix, name string, grants []transport.NewGrant, expires *time.Time) (transport.Share, error) {
	c, _, err := m.client()
	if err != nil {
		return transport.Share{}, err
	}
	vaultID, err := uuid.Parse(cloudVaultID)
	if err != nil {
		return transport.Share{}, fmt.Errorf("invalid: cloud vault id %q", cloudVaultID)
	}
	vaultName := ""
	switch v, err := c.GetVault(ctx, cloudVaultID); {
	case err == nil:
		if string(v.Kind) != "shared" {
			return transport.Share{}, &transport.ProblemError{
				Problem:    syncproto.Problem{Code: syncproto.CodeVaultEncrypted, Detail: "a private (end-to-end encrypted) vault cannot be shared"},
				StatusCode: 409,
			}
		}
		vaultName = v.Name
	case IsNotFound(err):
		// Not the caller's vault: a manager shares inside the share they manage.
	default:
		return transport.Share{}, err
	}
	name = strings.TrimSpace(name)
	prefix := strings.Trim(strings.TrimSpace(pathPrefix), "/")
	if name == "" {
		name = vaultName
		if prefix != "" {
			name = filepath.Base(prefix)
		}
	}
	in := transport.CreateShare{VaultId: vaultID, ResourceType: apiclient.ResourceType("vault"), DisplayName: name, ExpiresAt: expires}
	if prefix != "" {
		in.ResourceType = apiclient.ResourceType("folder")
		in.PathPrefix = &prefix
	}
	if len(grants) > 0 {
		in.Grants = &grants
	}
	return c.CreateShare(ctx, in)
}

// UpdateShare renames a share and sets or removes its expiry (owner or manager). An empty name
// keeps the current one; clearExpiry wins over expires.
func (m *Manager) UpdateShare(ctx context.Context, shareID, name string, expires *time.Time, clearExpiry bool) (transport.Share, error) {
	c, _, err := m.client()
	if err != nil {
		return transport.Share{}, err
	}
	var n *string
	if s := strings.TrimSpace(name); s != "" {
		n = &s
	}
	if clearExpiry {
		expires = nil
	}
	return c.UpdateShare(ctx, shareID, n, expires, clearExpiry)
}
