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

// sharingCallTimeout bounds a sharing call made by the UI. The transport retries network errors
// until its context ends: without a deadline a black-holed network (a dropped VPN, a captive
// portal) would hold the panel for minutes, and pile up a goroutine at every retry of the user.
var sharingCallTimeout = 30 * time.Second

// uiCtx is the context of a sharing binding: the application's, with sharingCallTimeout.
func (a *App) uiCtx() (context.Context, context.CancelFunc) {
	base := a.ctx
	if base == nil {
		base = context.Background()
	}
	return context.WithTimeout(base, sharingCallTimeout)
}

// canonicalShareID returns the canonical form of a share id given by the UI, which names the
// folder of its mount: anything else (a path, "<id>/.", an id in another case or form) would
// name another folder, or the same one under a name the open mounts are not keyed by.
func canonicalShareID(shareID string) (string, error) {
	id, err := uuid.Parse(shareID)
	if err != nil {
		return "", fmt.Errorf("invalid: share id %q", shareID)
	}
	return id.String(), nil
}

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
	OwnerID      string      `json:"ownerId"`
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
		DisplayName: s.DisplayName, OwnerID: s.OwnerId.String(), OwnerName: s.OwnerName, CreatedAt: s.CreatedAt.UTC().Format(time.RFC3339),
		MyPermission: string(deref(s.MyPermission)), MyStatus: string(deref(s.MyStatus)), Grants: []GrantInfo{},
	}
	if s.Id == (uuid.UUID{}) {
		out.ID, out.VaultID, out.OwnerID = "", "", "" // the zero Share of a failed call
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
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	shares, err := s.app.sync.Invitations(ctx)
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
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	m, err := s.app.sync.Mounts(ctx, s.app.mountsDir())
	if m == nil {
		m = []syncpkg.MountState{}
	}
	return m, bindingError(err)
}

// AcceptShare accepts an invitation and prepares the folder of its mount.
func (s *SharingAPI) AcceptShare(shareID string) (syncpkg.MountState, error) {
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	st, err := s.app.sync.AcceptShare(ctx, shareID, s.app.mountsDir())
	return st, bindingError(err)
}

// DeclineShare declines an invitation.
func (s *SharingAPI) DeclineShare(shareID string) error {
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	return bindingError(s.app.sync.DeclineShare(ctx, shareID))
}

// OpenMount makes sure the folder of an accepted share exists and opens it as a vault.
func (s *SharingAPI) OpenMount(shareID string) (VaultInfo, error) {
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	dir, err := s.app.sync.EnsureMount(ctx, shareID, s.app.mountsDir())
	if err != nil {
		return VaultInfo{}, bindingError(err)
	}
	return s.app.openVault(dir)
}

// RemoveMount ends a mount: the folder is deleted, or, with keepCopy, kept as an ordinary
// vault disconnected from the share (the choice offered after a revocation). It returns the
// vault of the kept copy (not opened) or an empty one. The vault of the mount, when open, is
// closed first: nothing may index, watch or synchronize a folder that is deleted or moved.
func (s *SharingAPI) RemoveMount(shareID string, keepCopy bool) (VaultInfo, error) {
	a := s.app
	shareID, err := canonicalShareID(shareID)
	if err != nil {
		return VaultInfo{}, err
	}
	ctx, cancel := a.uiCtx()
	defer cancel()
	dir := syncpkg.MountDir(a.mountsDir(), shareID)
	mm, isMount, err := syncpkg.ReadMount(ctx, dir)
	if err != nil {
		return VaultInfo{}, bindingError(err)
	}
	if !isMount || mm.ShareID != shareID {
		return VaultInfo{}, errors.New("not-found: this share is not mounted on this device")
	}
	// The open vault of the folder, found by its share and by its path (the id openVault gives it).
	open := map[string]bool{}
	if id := a.sync.MountVaultID(ctx, shareID); id != "" {
		open[id] = true
	}
	if abs, err := filepath.Abs(dir); err == nil {
		open[vaultID(abs)] = true
	}
	a.mu.Lock()
	for id := range open {
		if ov, ok := a.vaults[id]; ok {
			a.closeVaultLocked(id, ov)
		}
	}
	a.mu.Unlock()
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
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	shares, err := s.app.sync.VaultShares(ctx, vaultID)
	if err != nil {
		return nil, bindingError(err)
	}
	return toShareInfos(shares), nil
}

// parseExpiry reads an RFC 3339 expiry ("" for none).
func parseExpiry(expiresAt string) (*time.Time, error) {
	if expiresAt == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		return nil, errors.New("invalid: expiresAt must be an RFC 3339 date")
	}
	return &t, nil
}

// newGrants converts the recipients given by the UI.
func newGrants(grants []GrantInput) ([]transport.NewGrant, error) {
	gs := make([]transport.NewGrant, 0, len(grants))
	for _, g := range grants {
		pid, err := uuid.Parse(g.PrincipalID)
		if err != nil {
			return nil, fmt.Errorf("invalid: principal id %q", g.PrincipalID)
		}
		gs = append(gs, transport.NewGrant{PrincipalType: apiclient.NewGrantPrincipalType(g.PrincipalType), PrincipalId: pid, Permission: apiclient.SharePermission(g.Permission)})
	}
	return gs, nil
}

func toShareInfos(shares []transport.Share) []ShareInfo {
	out := make([]ShareInfo, 0, len(shares))
	for _, sh := range shares {
		out = append(out, toShareInfo(sh))
	}
	return out
}

// CreateShare shares a folder or a document (isDir false) of the open, connected vault; an empty
// path with isDir shares the whole vault. expiresAt is RFC 3339 or "".
func (s *SharingAPI) CreateShare(vaultID, path string, isDir bool, name string, grants []GrantInput, expiresAt string) (ShareInfo, error) {
	exp, err := parseExpiry(expiresAt)
	if err != nil {
		return ShareInfo{}, err
	}
	gs, err := newGrants(grants)
	if err != nil {
		return ShareInfo{}, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	sh, err := s.app.sync.CreateShare(ctx, vaultID, path, isDir, name, gs, exp)
	return toShareInfo(sh), bindingError(err)
}

// ListShares lists the shares of the account: "owned" (created or managed by the user, on any of
// their vaults) or "received" (invitations, accepted and declined ones).
func (s *SharingAPI) ListShares(scope string) ([]ShareInfo, error) {
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	shares, err := s.app.sync.ListShares(ctx, scope)
	if err != nil {
		return nil, bindingError(err)
	}
	return toShareInfos(shares), nil
}

// CreateCloudShare shares a whole cloud vault (empty pathPrefix) or one of its folders, by cloud
// vault id and without a local copy (Settings > Sharing, like the console). The caller owns the
// vault or manages a share of it and shares inside that share (ADR-0041 §8): the server decides.
// A private vault cannot be shared (D-02). expiresAt is RFC 3339 or "".
func (s *SharingAPI) CreateCloudShare(cloudVaultID, pathPrefix, name string, grants []GrantInput, expiresAt string) (ShareInfo, error) {
	exp, err := parseExpiry(expiresAt)
	if err != nil {
		return ShareInfo{}, err
	}
	gs, err := newGrants(grants)
	if err != nil {
		return ShareInfo{}, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	sh, err := s.app.sync.CreateCloudShare(ctx, cloudVaultID, pathPrefix, name, gs, exp)
	return toShareInfo(sh), bindingError(err)
}

// UpdateShare renames a share and sets (RFC 3339) or, with clearExpiry, removes its expiry (owner
// or manager). An empty name keeps the current one, an empty expiresAt the current expiry.
func (s *SharingAPI) UpdateShare(shareID, name, expiresAt string, clearExpiry bool) (ShareInfo, error) {
	exp, err := parseExpiry(expiresAt)
	if err != nil {
		return ShareInfo{}, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	sh, err := s.app.sync.UpdateShare(ctx, shareID, name, exp, clearExpiry)
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
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	sh, err := c.GetShare(ctx, shareID)
	return toShareInfo(sh), bindingError(err)
}

// RevokeShare ends a share (owner).
func (s *SharingAPI) RevokeShare(shareID string) error {
	c, err := s.client()
	if err != nil {
		return err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	return bindingError(c.RevokeShare(ctx, shareID))
}

// SetGrant adds a recipient or changes their level.
func (s *SharingAPI) SetGrant(shareID, principalType, principalID, permission string) (GrantInfo, error) {
	c, err := s.client()
	if err != nil {
		return GrantInfo{}, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	g, err := c.PutGrant(ctx, shareID, principalType, principalID, permission)
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
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	return bindingError(c.DeleteGrant(ctx, shareID, principalType, principalID))
}

// Directory searches users and groups to share with.
func (s *SharingAPI) Directory(query string) ([]DirectoryEntry, error) {
	c, err := s.client()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.app.uiCtx() // one deadline for both searches
	defer cancel()
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
