package transport

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"
)

// --- sharing API types (mirror api/openapi.yaml) ----------------------------

// Grant is one principal's access to a share.
type Grant struct {
	PrincipalType string    `json:"principal_type"` // user | group
	PrincipalID   string    `json:"principal_id"`
	PrincipalName string    `json:"principal_name"`
	Permission    string    `json:"permission"` // viewer | editor | manager
	Status        string    `json:"status"`     // pending | accepted | declined
	CreatedAt     time.Time `json:"created_at"`
}

// Share is a vault, folder or document shared with users and groups.
type Share struct {
	ID           string     `json:"id"`
	VaultID      string     `json:"vault_id"`
	VaultName    string     `json:"vault_name"`
	ResourceType string     `json:"resource_type"` // vault | folder | file
	PathPrefix   string     `json:"path_prefix"`
	FileID       string     `json:"file_id"`
	DisplayName  string     `json:"display_name"`
	OwnerID      string     `json:"owner_id"`
	OwnerName    string     `json:"owner_name"`
	CreatedAt    time.Time  `json:"created_at"`
	ExpiresAt    *time.Time `json:"expires_at"`
	MyPermission string     `json:"my_permission"`
	MyStatus     string     `json:"my_status"`
	Grants       []Grant    `json:"grants"`
}

// Mount is an accepted share, with the scope that syncs it.
type Mount struct {
	ShareID      string     `json:"share_id"`
	VaultID      string     `json:"vault_id"`
	DisplayName  string     `json:"display_name"`
	ResourceType string     `json:"resource_type"`
	Permission   string     `json:"permission"`
	Scope        string     `json:"scope"`
	OwnerName    string     `json:"owner_name"`
	ExpiresAt    *time.Time `json:"expires_at"`
}

// NewGrant is a recipient given while creating a share.
type NewGrant struct {
	PrincipalType string `json:"principal_type"`
	PrincipalID   string `json:"principal_id"`
	Permission    string `json:"permission"`
}

// CreateShare is the body of POST /shares.
type CreateShare struct {
	VaultID      string     `json:"vault_id"`
	ResourceType string     `json:"resource_type"`
	PathPrefix   string     `json:"path_prefix,omitempty"`
	FileID       string     `json:"file_id,omitempty"`
	DisplayName  string     `json:"display_name"`
	ExpiresAt    *time.Time `json:"expires_at,omitempty"`
	Grants       []NewGrant `json:"grants,omitempty"`
}

// DirectoryUser and DirectoryGroup are the minimal records of the directory.
type DirectoryUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

// DirectoryGroup is a group found by the directory search.
type DirectoryGroup struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// EffectiveConfig is GET /config/effective (§2.6.6).
type EffectiveConfig struct {
	Version    int            `json:"version"`
	Config     map[string]any `json:"config"`
	LockedKeys []string       `json:"locked_keys"`
}

// ListShares returns the shares the caller owns or manages ("owned") or was invited to ("received").
func (c *Client) ListShares(ctx context.Context, scope string) ([]Share, error) {
	var out []Share
	err := c.Do(ctx, http.MethodGet, "/shares?scope="+url.QueryEscape(scope), nil, &out, true)
	return out, err
}

// GetShare returns one share.
func (c *Client) GetShare(ctx context.Context, id string) (Share, error) {
	var out Share
	err := c.Do(ctx, http.MethodGet, "/shares/"+id, nil, &out, true)
	return out, err
}

// CreateShare shares a vault, folder or document.
func (c *Client) CreateShare(ctx context.Context, in CreateShare) (Share, error) {
	var out Share
	err := c.Do(ctx, http.MethodPost, "/shares", in, &out, true)
	return out, err
}

// RevokeShare ends a share (owner).
func (c *Client) RevokeShare(ctx context.Context, id string) error {
	return c.Do(ctx, http.MethodDelete, "/shares/"+id, nil, nil, true)
}

// UpdateShare renames a share and/or sets or removes its expiry.
func (c *Client) UpdateShare(ctx context.Context, id string, name *string, expires *time.Time, clearExpiry bool) (Share, error) {
	body := map[string]any{}
	if name != nil {
		body["display_name"] = *name
	}
	if expires != nil {
		body["expires_at"] = expires
	}
	if clearExpiry {
		body["clear_expiry"] = true
	}
	var out Share
	err := c.Do(ctx, http.MethodPatch, "/shares/"+id, body, &out, true)
	return out, err
}

// PutGrant adds a grant or changes its level.
func (c *Client) PutGrant(ctx context.Context, share, ptype, pid, permission string) (Grant, error) {
	var out Grant
	err := c.Do(ctx, http.MethodPut, "/shares/"+share+"/grants/"+ptype+"/"+pid, map[string]string{"permission": permission}, &out, true)
	return out, err
}

// DeleteGrant removes a grant.
func (c *Client) DeleteGrant(ctx context.Context, share, ptype, pid string) error {
	return c.Do(ctx, http.MethodDelete, "/shares/"+share+"/grants/"+ptype+"/"+pid, nil, nil, true)
}

// AcceptShare accepts an invitation.
func (c *Client) AcceptShare(ctx context.Context, id string) (Share, error) {
	var out Share
	err := c.Do(ctx, http.MethodPost, "/shares/"+id+":accept", nil, &out, true)
	return out, err
}

// DeclineShare declines an invitation.
func (c *Client) DeclineShare(ctx context.Context, id string) (Share, error) {
	var out Share
	err := c.Do(ctx, http.MethodPost, "/shares/"+id+":decline", nil, &out, true)
	return out, err
}

// SharedWithMe lists the accepted shares, each with the scope that syncs it.
func (c *Client) SharedWithMe(ctx context.Context) ([]Mount, error) {
	var out []Mount
	err := c.Do(ctx, http.MethodGet, "/shared-with-me", nil, &out, true)
	return out, err
}

// SearchUsers searches the directory for people to share with.
func (c *Client) SearchUsers(ctx context.Context, q string) ([]DirectoryUser, error) {
	var out []DirectoryUser
	err := c.Do(ctx, http.MethodGet, "/directory/users?q="+url.QueryEscape(q), nil, &out, true)
	return out, err
}

// SearchGroups searches the directory for groups to share with.
func (c *Client) SearchGroups(ctx context.Context, q string) ([]DirectoryGroup, error) {
	var out []DirectoryGroup
	err := c.Do(ctx, http.MethodGet, "/directory/groups?q="+url.QueryEscape(q), nil, &out, true)
	return out, err
}

// GetEffectiveConfig fetches the effective configuration. With a matching ETag the
// server answers 304 and changed is false (cfg is then zero).
func (c *Client) GetEffectiveConfig(ctx context.Context, etag string) (cfg EffectiveConfig, newETag string, changed bool, err error) {
	headers := map[string]string{"Accept": "application/json"}
	if etag != "" {
		headers["If-None-Match"] = etag
	}
	resp, err := c.raw(ctx, http.MethodGet, "/config/effective", nil, headers)
	if err != nil {
		return cfg, "", false, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotModified {
		_, _ = io.Copy(io.Discard, resp.Body)
		return cfg, etag, false, nil
	}
	if resp.StatusCode >= 400 {
		return cfg, "", false, decode(resp, nil)
	}
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		return cfg, "", false, err
	}
	return cfg, resp.Header.Get("ETag"), true, nil
}
