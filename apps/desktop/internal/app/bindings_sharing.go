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

	"clarae/apps/desktop/internal/app/cloudapi"
	"clarae/apps/desktop/internal/config"
	"clarae/apps/desktop/internal/features"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/sync/transport"
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

// SharingAPI exposes shares and mounts to the frontend (§2.6.4). Changes also arrive as
// shares:changed, mount:revoked and vault events. Shares, grants and directory entries are the
// OpenAPI types of package cloudapi (ADR-0045 §6): the UI gets the JSON of the REST API, as the
// console does; mounts are a state of this device (sync.MountState).
type SharingAPI struct{ app *App }

// NewSharingAPI binds the API.
func NewSharingAPI(a *App) *SharingAPI { return &SharingAPI{app: a} }

// Invitations lists the shares waiting for the user's answer.
func (s *SharingAPI) Invitations() ([]cloudapi.Share, error) {
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	shares, err := s.app.sync.Invitations(ctx)
	if err != nil {
		return nil, bindingError(err)
	}
	return cloudapi.SharesOf(shares), nil
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
// vault disconnected from the share (the choice offered after a revocation; not in the browser,
// where nothing could open that folder again). It returns the vault of the kept copy (not
// opened) or an empty one. The vault of the mount, when open, is closed first: nothing may
// index, watch or synchronize a folder that is deleted or moved.
func (s *SharingAPI) RemoveMount(shareID string, keepCopy bool) (VaultInfo, error) {
	a := s.app
	shareID, err := canonicalShareID(shareID)
	if err != nil {
		return VaultInfo{}, err
	}
	if keepCopy && isWeb {
		// The browser has no place where a kept folder could be opened again: the UI offers to
		// download the copy as a ZIP instead (capability detachedCopies). Refused before anything
		// is closed or moved.
		return VaultInfo{}, errors.New("unsupported: a copy cannot be kept as a folder in the browser; download it as a ZIP instead")
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
func (s *SharingAPI) VaultShares(vaultID string) ([]cloudapi.Share, error) {
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	shares, err := s.app.sync.VaultShares(ctx, vaultID)
	if err != nil {
		return nil, bindingError(err)
	}
	return cloudapi.SharesOf(shares), nil
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
func newGrants(grants []cloudapi.NewGrant) []transport.NewGrant {
	gs := make([]transport.NewGrant, 0, len(grants))
	for _, g := range grants {
		gs = append(gs, g.API())
	}
	return gs
}

// shareResult is the result of a binding that returns one share: the error alone on failure.
func shareResult(sh transport.Share, err error) (cloudapi.Share, error) {
	if err != nil {
		return cloudapi.Share{}, bindingError(err)
	}
	return cloudapi.ShareOf(sh), nil
}

// CreateShare shares a folder or a document (isDir false) of the open, connected vault; an empty
// path with isDir shares the whole vault. expiresAt is RFC 3339 or "".
func (s *SharingAPI) CreateShare(vaultID, path string, isDir bool, name string, grants []cloudapi.NewGrant, expiresAt string) (cloudapi.Share, error) {
	exp, err := parseExpiry(expiresAt)
	if err != nil {
		return cloudapi.Share{}, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	return shareResult(s.app.sync.CreateShare(ctx, vaultID, path, isDir, name, newGrants(grants), exp))
}

// ListShares lists a page of the shares of the account, newest first: "owned" (created or managed
// by the user, on any of their vaults) or "received" (invitations and accepted shares). cursor is
// "" for the first page, then the next_cursor of the page before, absent on the last one
// (GET /shares, api/openapi.yaml "Pagination").
func (s *SharingAPI) ListShares(scope, cursor string) (cloudapi.SharePage, error) {
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	page, err := s.app.sync.ListSharesPage(ctx, scope, cursor)
	if err != nil {
		return cloudapi.SharePage{}, bindingError(err)
	}
	return cloudapi.SharePageOf(page), nil
}

// CreateCloudShare shares a whole cloud vault (empty pathPrefix) or one of its folders, by cloud
// vault id and without a local copy (Settings > Sharing, like the console). The caller owns the
// vault or manages a share of it and shares inside that share (ADR-0041 §8): the server decides.
// A private vault cannot be shared (D-02). expiresAt is RFC 3339 or "".
func (s *SharingAPI) CreateCloudShare(cloudVaultID, pathPrefix, name string, grants []cloudapi.NewGrant, expiresAt string) (cloudapi.Share, error) {
	exp, err := parseExpiry(expiresAt)
	if err != nil {
		return cloudapi.Share{}, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	return shareResult(s.app.sync.CreateCloudShare(ctx, cloudVaultID, pathPrefix, name, newGrants(grants), exp))
}

// UpdateShare renames a share and sets or, with clear_expiry, removes its expiry (owner or
// manager): the body of PATCH /shares/{id}. An absent or empty name keeps the current one, an
// absent expiry the current expiry.
func (s *SharingAPI) UpdateShare(shareID string, change cloudapi.UpdateShare) (cloudapi.Share, error) {
	name := ""
	if change.DisplayName != nil {
		name = *change.DisplayName
	}
	clear := change.ClearExpiry != nil && *change.ClearExpiry
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	return shareResult(s.app.sync.UpdateShare(ctx, shareID, name, change.ExpiresAt, clear))
}

func (s *SharingAPI) client() (*transport.Client, error) {
	c := s.app.auth.Client()
	if c == nil {
		return nil, errors.New("not signed in to the cloud")
	}
	return c, nil
}

// Share returns one share with its grants (owner and managers).
func (s *SharingAPI) Share(shareID string) (cloudapi.Share, error) {
	c, err := s.client()
	if err != nil {
		return cloudapi.Share{}, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	return shareResult(c.GetShare(ctx, shareID))
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
func (s *SharingAPI) SetGrant(shareID, principalType, principalID, permission string) (cloudapi.Grant, error) {
	c, err := s.client()
	if err != nil {
		return cloudapi.Grant{}, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	g, err := c.PutGrant(ctx, shareID, principalType, principalID, permission)
	if err != nil {
		return cloudapi.Grant{}, bindingError(err)
	}
	return cloudapi.GrantOf(g), nil
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

// SearchDirectoryUsers finds users to share with (GET /directory/users): one request to the
// directory of users, as the console makes, so a failure of the groups does not hide them.
func (s *SharingAPI) SearchDirectoryUsers(query string) ([]cloudapi.DirectoryUser, error) {
	c, err := s.client()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	users, err := c.SearchUsers(ctx, query)
	if err != nil {
		return nil, bindingError(err)
	}
	return cloudapi.DirectoryUsersOf(users), nil
}

// SearchDirectoryGroups finds groups to share with (GET /directory/groups).
func (s *SharingAPI) SearchDirectoryGroups(query string) ([]cloudapi.DirectoryGroup, error) {
	c, err := s.client()
	if err != nil {
		return nil, err
	}
	ctx, cancel := s.app.uiCtx()
	defer cancel()
	groups, err := c.SearchGroups(ctx, query)
	if err != nil {
		return nil, bindingError(err)
	}
	return cloudapi.DirectoryGroupsOf(groups), nil
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
