// Package keycloak is a minimal client of the Keycloak Admin REST API (§3.5.5).
// It authenticates as the realm's service account (client credentials), caches
// the access token until shortly before it expires and exposes only what the
// admin console needs: create users, enable/disable, log out, list sessions,
// require a password change and set the global realm role. The service account
// needs the realm-management roles manage-users, view-users and query-users.
package keycloak

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"clarae/services/cloud/internal/auth"
)

// Errors returned by the client.
var (
	// ErrExists means a user with that username or e-mail already exists.
	ErrExists = errors.New("keycloak: user already exists")
	// ErrNotFound means Keycloak has no such user or role.
	ErrNotFound = errors.New("keycloak: not found")
	// ErrDisabled means no Keycloak is configured (standalone installations).
	ErrDisabled = errors.New("keycloak: admin client not configured")
)

// UserSpec describes a user to create.
type UserSpec struct {
	Username  string
	Email     string
	FirstName string
	// TemporaryPassword, when set, must be changed at the first login.
	TemporaryPassword string
	Admin             bool
}

// Session is an open SSO session of a user.
type Session struct {
	ID         string
	IPAddress  string
	Started    time.Time
	LastAccess time.Time
	Clients    []string
}

// Admin is what the admin module needs from Keycloak. The HTTP client implements
// it; tests substitute fakes.
type Admin interface {
	CreateUser(ctx context.Context, u UserSpec) (sub string, err error)
	UpdateUser(ctx context.Context, sub, email, firstName string) error
	SetEnabled(ctx context.Context, sub string, enabled bool) error
	LogoutUser(ctx context.Context, sub string) error
	Sessions(ctx context.Context, sub string) ([]Session, error)
	// RequirePasswordReset marks UPDATE_PASSWORD as required and tries to send the
	// e-mail; emailSent is false when Keycloak could not (no SMTP configured).
	RequirePasswordReset(ctx context.Context, sub string) (emailSent bool, err error)
	SetAdmin(ctx context.Context, sub string, admin bool) error
}

// Config locates the realm and the service account.
type Config struct {
	BaseURL      string
	Realm        string
	ClientID     string
	ClientSecret string
	// AdminRoles are the realm roles that make a user an administrator (OIDC_ADMIN_ROLES), in
	// order of preference: SetAdmin grants the first one the realm has and revokes every one
	// the user holds. Empty means auth.DefaultAdminRoles.
	AdminRoles []string
}

// Enabled reports whether the configuration is usable.
func (c Config) Enabled() bool { return c.BaseURL != "" && c.Realm != "" && c.ClientSecret != "" }

// Client talks to the Admin REST API.
type Client struct {
	cfg  Config
	http *http.Client

	mu      sync.Mutex
	token   string
	expires time.Time
}

// New returns a client; with an incomplete configuration it returns a Disabled stub.
func New(cfg Config) Admin {
	if !cfg.Enabled() {
		return Disabled{}
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if len(cfg.AdminRoles) == 0 {
		cfg.AdminRoles = auth.DefaultAdminRoles
	}
	return &Client{cfg: cfg, http: &http.Client{Timeout: 15 * time.Second}}
}

func (c *Client) bearer(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Before(c.expires) {
		return c.token, nil
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {c.cfg.ClientID}, "client_secret": {c.cfg.ClientSecret}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/realms/%s/protocol/openid-connect/token", c.cfg.BaseURL, url.PathEscape(c.cfg.Realm)),
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("keycloak token: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("keycloak token: %s", resp.Status)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return "", fmt.Errorf("keycloak token: %w", err)
	}
	c.token = tok.AccessToken
	c.expires = time.Now().Add(time.Duration(tok.ExpiresIn)*time.Second - 30*time.Second)
	return c.token, nil
}

// do sends an admin request; body (if any) is JSON. It returns the response, which the caller closes.
func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	tok, err := c.bearer(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("%s/admin/realms/%s%s", c.cfg.BaseURL, url.PathEscape(c.cfg.Realm), path), rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		// The cached token was revoked or the realm keys rotated: forget it for the next call.
		c.mu.Lock()
		c.token = ""
		c.mu.Unlock()
	}
	return resp, nil
}

func (c *Client) call(ctx context.Context, method, path string, body any, out any) error {
	resp, err := c.do(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case resp.StatusCode == http.StatusConflict:
		return ErrExists
	case resp.StatusCode >= 300:
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("keycloak %s %s: %s %s", method, path, resp.Status, strings.TrimSpace(string(msg)))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

type userRep struct {
	Username        string   `json:"username,omitempty"`
	Email           string   `json:"email,omitempty"`
	FirstName       string   `json:"firstName,omitempty"`
	Enabled         *bool    `json:"enabled,omitempty"`
	EmailVerified   *bool    `json:"emailVerified,omitempty"`
	RequiredActions []string `json:"requiredActions,omitempty"`
	Credentials     []cred   `json:"credentials,omitempty"`
}

type cred struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	Temporary bool   `json:"temporary"`
}

// CreateUser creates the account. Without a temporary password the user must set one
// (and verify the e-mail) at the first login.
func (c *Client) CreateUser(ctx context.Context, u UserSpec) (string, error) {
	yes := true
	rep := userRep{Username: u.Username, Email: u.Email, FirstName: u.FirstName, Enabled: &yes}
	if u.TemporaryPassword != "" {
		rep.Credentials = []cred{{Type: "password", Value: u.TemporaryPassword, Temporary: true}}
	} else {
		rep.RequiredActions = []string{"UPDATE_PASSWORD", "VERIFY_EMAIL"}
	}
	resp, err := c.do(ctx, http.MethodPost, "/users", rep)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusConflict {
		return "", ErrExists
	}
	if resp.StatusCode != http.StatusCreated {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("keycloak create user: %s %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	loc := resp.Header.Get("Location")
	sub := loc[strings.LastIndex(loc, "/")+1:]
	if sub == "" {
		return "", errors.New("keycloak create user: no Location header")
	}
	if u.Admin {
		if err := c.SetAdmin(ctx, sub, true); err != nil {
			return sub, err
		}
	}
	return sub, nil
}

// UpdateUser changes e-mail and first name (empty values are left alone).
func (c *Client) UpdateUser(ctx context.Context, sub, email, firstName string) error {
	return c.call(ctx, http.MethodPut, "/users/"+url.PathEscape(sub), userRep{Email: email, FirstName: firstName}, nil)
}

// SetEnabled enables or disables the account; disabling also ends its sessions.
func (c *Client) SetEnabled(ctx context.Context, sub string, enabled bool) error {
	// "enabled": false must be sent explicitly, hence a map rather than userRep.
	if err := c.call(ctx, http.MethodPut, "/users/"+url.PathEscape(sub), map[string]any{"enabled": enabled}, nil); err != nil {
		return err
	}
	if !enabled {
		return c.LogoutUser(ctx, sub)
	}
	return nil
}

// LogoutUser revokes every session of the user.
func (c *Client) LogoutUser(ctx context.Context, sub string) error {
	return c.call(ctx, http.MethodPost, "/users/"+url.PathEscape(sub)+"/logout", nil, nil)
}

// Sessions lists the open sessions of the user.
func (c *Client) Sessions(ctx context.Context, sub string) ([]Session, error) {
	var raw []struct {
		ID         string            `json:"id"`
		IPAddress  string            `json:"ipAddress"`
		Start      int64             `json:"start"`
		LastAccess int64             `json:"lastAccess"`
		Clients    map[string]string `json:"clients"`
	}
	if err := c.call(ctx, http.MethodGet, "/users/"+url.PathEscape(sub)+"/sessions", nil, &raw); err != nil {
		return nil, err
	}
	out := make([]Session, 0, len(raw))
	for _, s := range raw {
		sess := Session{ID: s.ID, IPAddress: s.IPAddress, Started: time.UnixMilli(s.Start).UTC(), LastAccess: time.UnixMilli(s.LastAccess).UTC()}
		for _, name := range s.Clients {
			sess.Clients = append(sess.Clients, name)
		}
		out = append(out, sess)
	}
	return out, nil
}

// RequirePasswordReset adds the UPDATE_PASSWORD required action and tries to send the e-mail.
func (c *Client) RequirePasswordReset(ctx context.Context, sub string) (bool, error) {
	if err := c.call(ctx, http.MethodPut, "/users/"+url.PathEscape(sub), userRep{RequiredActions: []string{"UPDATE_PASSWORD"}}, nil); err != nil {
		return false, err
	}
	err := c.call(ctx, http.MethodPut, "/users/"+url.PathEscape(sub)+"/execute-actions-email", []string{"UPDATE_PASSWORD"}, nil)
	return err == nil, nil
}

// SetAdmin grants or removes the administrator realm role. The realm may have the role of 1.x
// (memobrain-admin), the new one (clarae-admin) or both (Config.AdminRoles): granting assigns the
// first of them the realm has, revoking removes every one the user holds, so that a demoted
// administrator does not keep the other name. The roles are looked up through the user's own
// role mappings (available / current) rather than GET /roles/{name}: that way the service
// account needs only manage-users, not view-realm.
func (c *Client) SetAdmin(ctx context.Context, sub string, admin bool) error {
	type role struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	list := "/users/" + url.PathEscape(sub) + "/role-mappings/realm"
	source, method := list, http.MethodDelete
	if admin {
		source, method = list+"/available", http.MethodPost
	}
	var roles []role
	if err := c.call(ctx, http.MethodGet, source, nil, &roles); err != nil {
		return err
	}
	var matching []role
	for _, name := range c.cfg.AdminRoles {
		for _, r := range roles {
			if r.Name == name {
				matching = append(matching, r)
				break
			}
		}
	}
	if len(matching) > 0 {
		if admin {
			matching = matching[:1]
		}
		return c.call(ctx, method, list, matching, nil)
	}
	if admin {
		// Not among the available roles: either the user has one already or the realm has none of them.
		var current []role
		if err := c.call(ctx, http.MethodGet, list, nil, &current); err != nil {
			return err
		}
		for _, r := range current {
			if slices.Contains(c.cfg.AdminRoles, r.Name) {
				return nil
			}
		}
		return fmt.Errorf("keycloak: none of the realm roles %v exists", c.cfg.AdminRoles)
	}
	return nil // not granted: nothing to revoke
}

// Disabled is the Admin used when Keycloak is not configured: every call fails with ErrDisabled.
type Disabled struct{}

// CreateUser implements Admin.
func (Disabled) CreateUser(context.Context, UserSpec) (string, error) { return "", ErrDisabled }

// UpdateUser implements Admin.
func (Disabled) UpdateUser(context.Context, string, string, string) error { return ErrDisabled }

// SetEnabled implements Admin.
func (Disabled) SetEnabled(context.Context, string, bool) error { return ErrDisabled }

// LogoutUser implements Admin.
func (Disabled) LogoutUser(context.Context, string) error { return ErrDisabled }

// Sessions implements Admin.
func (Disabled) Sessions(context.Context, string) ([]Session, error) { return nil, ErrDisabled }

// RequirePasswordReset implements Admin.
func (Disabled) RequirePasswordReset(context.Context, string) (bool, error) {
	return false, ErrDisabled
}

// SetAdmin implements Admin.
func (Disabled) SetAdmin(context.Context, string, bool) error { return ErrDisabled }
