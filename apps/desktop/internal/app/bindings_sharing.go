package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"memobrain/apps/desktop/internal/config"
	"memobrain/apps/desktop/internal/features"
	syncpkg "memobrain/apps/desktop/internal/sync"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/apiclient"
)

// ErrReadOnly is the error of a write on a vault the user may only read.
var errReadOnly = errors.New("read-only: this folder was shared with you as a viewer")

// writable refuses writes to a mount shared as viewer, or whose share was revoked.
func (a *App) writable(vaultID string) error {
	if a.sync.ReadOnly(context.Background(), vaultID) {
		return errReadOnly
	}
	return nil
}

func (a *App) mountsDir() string { return filepath.Join(a.opts.DataDir, "mounts") }

// GrantInfo is one recipient of a share.
type GrantInfo struct {
	PrincipalType string `json:"principalType"` // user | group
	PrincipalID   string `json:"principalId"`
	PrincipalName string `json:"principalName"`
	Permission    string `json:"permission"`
	Status        string `json:"status"`
}

// ShareInfo is a share as the UI lists it.
type ShareInfo struct {
	ID           string      `json:"id"`
	VaultID      string      `json:"vaultId"`
	VaultName    string      `json:"vaultName"`
	ResourceType string      `json:"resourceType"`
	PathPrefix   string      `json:"pathPrefix"`
	DisplayName  string      `json:"displayName"`
	OwnerName    string      `json:"ownerName"`
	CreatedAt    string      `json:"createdAt"`
	ExpiresAt    string      `json:"expiresAt"`
	MyPermission string      `json:"myPermission"`
	MyStatus     string      `json:"myStatus"`
	Grants       []GrantInfo `json:"grants"`
}

// GrantInput is a recipient given while creating a share.
type GrantInput struct {
	PrincipalType string `json:"principalType"`
	PrincipalID   string `json:"principalId"`
	Permission    string `json:"permission"`
}

// DirectoryEntry is a user or group found by the directory search.
type DirectoryEntry struct {
	Type  string `json:"type"` // user | group
	ID    string `json:"id"`
	Name  string `json:"name"`
	Label string `json:"label"`
}

func toShareInfo(s transport.Share) ShareInfo {
	out := ShareInfo{
		ID: s.Id.String(), VaultID: s.VaultId.String(), VaultName: s.VaultName, ResourceType: string(s.ResourceType), PathPrefix: deref(s.PathPrefix),
		DisplayName: s.DisplayName, OwnerName: s.OwnerName, CreatedAt: s.CreatedAt.UTC().Format(time.RFC3339),
		MyPermission: string(deref(s.MyPermission)), MyStatus: string(deref(s.MyStatus)), Grants: []GrantInfo{},
	}
	if s.Id == (uuid.UUID{}) {
		out.ID, out.VaultID = "", "" // the zero Share of a failed call
	}
	if s.ExpiresAt != nil {
		out.ExpiresAt = s.ExpiresAt.UTC().Format(time.RFC3339)
	}
	for _, g := range deref(s.Grants) {
		out.Grants = append(out.Grants, toGrantInfo(g))
	}
	return out
}

func toGrantInfo(g transport.Grant) GrantInfo {
	return GrantInfo{PrincipalType: string(g.PrincipalType), PrincipalID: g.PrincipalId.String(), PrincipalName: g.PrincipalName, Permission: string(g.Permission), Status: string(g.Status)}
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

// SharingAPI exposes shares and mounts to the frontend (§2.6.4). Changes also arrive as
// shares:changed, mount:revoked and vault events.
type SharingAPI struct{ app *App }

// NewSharingAPI binds the API.
func NewSharingAPI(a *App) *SharingAPI { return &SharingAPI{app: a} }

// Invitations lists the shares waiting for the user's answer.
func (s *SharingAPI) Invitations() ([]ShareInfo, error) {
	shares, err := s.app.sync.Invitations(context.Background())
	if err != nil {
		return nil, bindingError(err)
	}
	out := make([]ShareInfo, 0, len(shares))
	for _, sh := range shares {
		out = append(out, toShareInfo(sh))
	}
	return out, nil
}

// Mounts lists the accepted shares with the state of their folders on this device.
func (s *SharingAPI) Mounts() ([]syncpkg.MountState, error) {
	m, err := s.app.sync.Mounts(context.Background(), s.app.mountsDir())
	if m == nil {
		m = []syncpkg.MountState{}
	}
	return m, bindingError(err)
}

// AcceptShare accepts an invitation and prepares the folder of its mount.
func (s *SharingAPI) AcceptShare(shareID string) (syncpkg.MountState, error) {
	st, err := s.app.sync.AcceptShare(context.Background(), shareID, s.app.mountsDir())
	return st, bindingError(err)
}

// DeclineShare declines an invitation.
func (s *SharingAPI) DeclineShare(shareID string) error {
	return bindingError(s.app.sync.DeclineShare(context.Background(), shareID))
}

// OpenMount makes sure the folder of an accepted share exists and opens it as a vault.
func (s *SharingAPI) OpenMount(shareID string) (VaultInfo, error) {
	dir, err := s.app.sync.EnsureMount(context.Background(), shareID, s.app.mountsDir())
	if err != nil {
		return VaultInfo{}, bindingError(err)
	}
	return s.app.openVault(dir)
}

// RemoveMount ends a mount: the folder is deleted, or, with keepCopy, kept as an ordinary
// vault disconnected from the share (the choice offered after a revocation). It returns the
// vault of the kept copy (not opened) or an empty one.
func (s *SharingAPI) RemoveMount(shareID string, keepCopy bool) (VaultInfo, error) {
	a := s.app
	ctx := context.Background()
	dir := syncpkg.MountDir(a.mountsDir(), shareID)
	mm, isMount, err := syncpkg.ReadMount(ctx, dir)
	if err != nil {
		return VaultInfo{}, bindingError(err)
	}
	if !isMount {
		return VaultInfo{}, errors.New("not-found: this share is not mounted on this device")
	}
	if id := a.sync.MountVaultID(ctx, shareID); id != "" {
		a.mu.Lock()
		if ov, ok := a.vaults[id]; ok {
			a.closeVaultLocked(id, ov)
		}
		a.mu.Unlock()
	}
	if !keepCopy {
		return VaultInfo{}, bindingError(os.RemoveAll(dir))
	}
	if err := syncpkg.ForgetMount(ctx, dir); err != nil {
		return VaultInfo{}, bindingError(err)
	}
	kept := filepath.Join(a.opts.DataDir, "kept")
	if err := os.MkdirAll(kept, 0o755); err != nil {
		return VaultInfo{}, err
	}
	target := uniqueDir(kept, sanitizeName(mm.Name+" ("+mm.OwnerName+")"))
	if err := os.Rename(dir, target); err != nil {
		return VaultInfo{}, err
	}
	return VaultInfo{ID: vaultID(target), Name: filepath.Base(target), Path: target}, nil
}

func sanitizeName(s string) string {
	r := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-", "\"", "-", "<", "-", ">", "-", "|", "-")
	s = strings.TrimSpace(r.Replace(s))
	if s == "" {
		return "Shared"
	}
	return s
}

func uniqueDir(parent, name string) string {
	p := filepath.Join(parent, name)
	for i := 2; ; i++ {
		if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
			return p
		}
		p = filepath.Join(parent, fmt.Sprintf("%s %d", name, i))
	}
}

// VaultShares lists the shares of the open vault's cloud copy that the user owns.
func (s *SharingAPI) VaultShares(vaultID string) ([]ShareInfo, error) {
	shares, err := s.app.sync.VaultShares(context.Background(), vaultID)
	if err != nil {
		return nil, bindingError(err)
	}
	out := make([]ShareInfo, 0, len(shares))
	for _, sh := range shares {
		out = append(out, toShareInfo(sh))
	}
	return out, nil
}

// CreateShare shares a folder or a document (isDir false) of the open, connected vault; an empty
// path with isDir shares the whole vault. expiresAt is RFC 3339 or "".
func (s *SharingAPI) CreateShare(vaultID, path string, isDir bool, name string, grants []GrantInput, expiresAt string) (ShareInfo, error) {
	var exp *time.Time
	if expiresAt != "" {
		t, err := time.Parse(time.RFC3339, expiresAt)
		if err != nil {
			return ShareInfo{}, errors.New("invalid: expiresAt must be an RFC 3339 date")
		}
		exp = &t
	}
	gs := make([]transport.NewGrant, 0, len(grants))
	for _, g := range grants {
		pid, err := uuid.Parse(g.PrincipalID)
		if err != nil {
			return ShareInfo{}, fmt.Errorf("invalid: principal id %q", g.PrincipalID)
		}
		gs = append(gs, transport.NewGrant{PrincipalType: apiclient.NewGrantPrincipalType(g.PrincipalType), PrincipalId: pid, Permission: apiclient.SharePermission(g.Permission)})
	}
	sh, err := s.app.sync.CreateShare(context.Background(), vaultID, path, isDir, name, gs, exp)
	return toShareInfo(sh), bindingError(err)
}

func (s *SharingAPI) client() (*transport.Client, error) {
	c := s.app.auth.Client()
	if c == nil {
		return nil, errors.New("not signed in to the cloud")
	}
	return c, nil
}

// Share returns one share with its grants (owner and managers).
func (s *SharingAPI) Share(shareID string) (ShareInfo, error) {
	c, err := s.client()
	if err != nil {
		return ShareInfo{}, err
	}
	sh, err := c.GetShare(context.Background(), shareID)
	return toShareInfo(sh), bindingError(err)
}

// RevokeShare ends a share (owner).
func (s *SharingAPI) RevokeShare(shareID string) error {
	c, err := s.client()
	if err != nil {
		return err
	}
	return bindingError(c.RevokeShare(context.Background(), shareID))
}

// SetGrant adds a recipient or changes their level.
func (s *SharingAPI) SetGrant(shareID, principalType, principalID, permission string) (GrantInfo, error) {
	c, err := s.client()
	if err != nil {
		return GrantInfo{}, err
	}
	g, err := c.PutGrant(context.Background(), shareID, principalType, principalID, permission)
	if err != nil {
		return GrantInfo{}, bindingError(err)
	}
	return toGrantInfo(g), nil
}

// RemoveGrant takes a recipient out of a share.
func (s *SharingAPI) RemoveGrant(shareID, principalType, principalID string) error {
	c, err := s.client()
	if err != nil {
		return err
	}
	return bindingError(c.DeleteGrant(context.Background(), shareID, principalType, principalID))
}

// Directory searches users and groups to share with.
func (s *SharingAPI) Directory(query string) ([]DirectoryEntry, error) {
	c, err := s.client()
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	users, err := c.SearchUsers(ctx, query)
	if err != nil {
		return nil, bindingError(err)
	}
	groups, err := c.SearchGroups(ctx, query)
	if err != nil {
		return nil, bindingError(err)
	}
	out := make([]DirectoryEntry, 0, len(users)+len(groups))
	for _, u := range users {
		label := u.Username
		if dn := deref(u.DisplayName); dn != "" {
			label = dn + " (" + u.Username + ")"
		}
		out = append(out, DirectoryEntry{Type: "user", ID: u.Id.String(), Name: u.Username, Label: label})
	}
	for _, g := range groups {
		out = append(out, DirectoryEntry{Type: "group", ID: g.Id.String(), Name: g.Name, Label: g.Name})
	}
	return out, nil
}

// ConfigAPI exposes the configuration distributed by the cloud (§2.6.6).
type ConfigAPI struct{ app *App }

// NewConfigAPI binds the API.
func NewConfigAPI(a *App) *ConfigAPI { return &ConfigAPI{app: a} }

// ConfigState is the configuration in force and the feature flags derived from it.
type ConfigState struct {
	config.Effective
	Features map[string]bool `json:"features"`
}

func (a *App) configState() ConfigState {
	cur := a.config.Current()
	return ConfigState{Effective: cur, Features: features.Flags(cur.Config)}
}

// Effective returns the configuration in force (cached when offline).
func (c *ConfigAPI) Effective() ConfigState { return c.app.configState() }

// Refresh fetches the configuration now.
func (c *ConfigAPI) Refresh() (ConfigState, error) {
	err := c.app.refreshConfig(context.Background())
	return c.app.configState(), bindingError(err)
}
