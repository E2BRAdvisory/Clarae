//go:build integration

package integration

import (
	"context"
	"encoding/csv"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/auth/authtest"
	"memobrain/services/cloud/internal/keycloak"
	"memobrain/services/cloud/internal/notify"
)

// fakeKeycloak records the Admin API calls and stands in for the identity provider.
type fakeKeycloak struct {
	mu       sync.Mutex
	users    map[string]keycloak.UserSpec // by subject
	enabled  map[string]bool
	admins   map[string]bool
	logouts  []string
	resets   []string
	emailOK  bool
	sessions map[string][]keycloak.Session
}

func newFakeKeycloak() *fakeKeycloak {
	return &fakeKeycloak{users: map[string]keycloak.UserSpec{}, enabled: map[string]bool{}, admins: map[string]bool{}, sessions: map[string][]keycloak.Session{}, emailOK: true}
}

func (f *fakeKeycloak) CreateUser(_ context.Context, u keycloak.UserSpec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, x := range f.users {
		if x.Username == u.Username || x.Email == u.Email {
			return "", keycloak.ErrExists
		}
	}
	sub := "kc-" + uuid.NewString()
	f.users[sub], f.enabled[sub], f.admins[sub] = u, true, u.Admin
	return sub, nil
}

func (f *fakeKeycloak) UpdateUser(context.Context, string, string, string) error { return nil }

func (f *fakeKeycloak) SetEnabled(_ context.Context, sub string, on bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.enabled[sub] = on
	if !on {
		f.logouts = append(f.logouts, sub)
	}
	return nil
}

func (f *fakeKeycloak) LogoutUser(_ context.Context, sub string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logouts = append(f.logouts, sub)
	return nil
}

func (f *fakeKeycloak) Sessions(_ context.Context, sub string) ([]keycloak.Session, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sessions[sub], nil
}

func (f *fakeKeycloak) RequirePasswordReset(_ context.Context, sub string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resets = append(f.resets, sub)
	return f.emailOK, nil
}

func (f *fakeKeycloak) SetAdmin(_ context.Context, sub string, on bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.admins[sub] = on
	return nil
}

func (f *fakeKeycloak) isEnabled(sub string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.enabled[sub]
}

// admin is a user carrying the memobrain-admin realm role.
func (e *env) admin(name string) *client {
	e.t.Helper()
	return e.userWith(name, "sub-"+name+"-"+uuid.NewString(), "memobrain-admin", "memobrain-user")
}

func (e *env) userWith(name, subject string, roles ...string) *client {
	e.t.Helper()
	c := &client{e: e, token: e.issuer.Token(e.t, authtest.TokenOptions{Subject: subject, Username: name, Email: name + "-" + uuid.NewString()[:8] + "@memobrain.local", Roles: roles})}
	me := decode[map[string]any](e.t, c.json(http.MethodGet, "/me", nil))
	c.userID, _ = me["id"].(string)
	dev := decode[map[string]any](e.t, c.json(http.MethodPost, "/me/devices", map[string]any{"name": name + "-laptop", "platform": "linux"}))
	c.deviceID, _ = dev["id"].(string)
	return c
}

func problemCode(t *testing.T, resp *http.Response) string {
	t.Helper()
	return decode[map[string]any](t, resp)["code"].(string)
}

type adminUser struct {
	ID                 string `json:"id"`
	Username           string `json:"username"`
	Email              string `json:"email"`
	Role               string `json:"role"`
	Status             string `json:"status"`
	QuotaBytes         int64  `json:"quota_bytes"`
	QuotaBytesOverride *int64 `json:"quota_bytes_override"`
}

func (c *client) createUser(username, email, role string) adminUser {
	c.e.t.Helper()
	resp := c.json(http.MethodPost, "/admin/users", map[string]any{"username": username, "email": email, "role": role, "display_name": "Display " + username})
	expect(c.e.t, resp, http.StatusCreated)
	return decode[adminUser](c.e.t, resp)
}

func TestAdminEndpointsRequireTheAdminRole(t *testing.T) {
	e := newEnv(t)
	bob := e.user("bob")
	for _, p := range []string{"/admin/users", "/admin/groups", "/admin/config-profiles", "/admin/settings/storage", "/admin/storage/overview", "/admin/audit-log"} {
		resp := bob.json(http.MethodGet, p, nil)
		expect(t, resp, http.StatusForbidden)
		if code := problemCode(t, resp); code != "FORBIDDEN" {
			t.Fatalf("%s: code %s", p, code)
		}
	}
	root := e.admin("root")
	expect(t, root.json(http.MethodGet, "/admin/users", nil), http.StatusOK)
}

func TestAdminCreatesSuspendsAndReactivatesAUser(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")

	u := root.createUser("nina", "nina@memobrain.local", "user")
	if u.Status != "active" || u.Role != "user" || u.QuotaBytes != 5<<30 {
		t.Fatalf("created user: %+v", u)
	}
	var sub string
	e.kc.mu.Lock()
	for s, spec := range e.kc.users {
		if spec.Username == "nina" {
			sub = s
		}
	}
	e.kc.mu.Unlock()
	if sub == "" {
		t.Fatal("the user was not created in Keycloak")
	}
	// A second account with the same username is refused.
	expect(t, root.json(http.MethodPost, "/admin/users", map[string]any{"username": "nina", "email": "other@memobrain.local"}), http.StatusConflict)
	// Invalid e-mail.
	expect(t, root.json(http.MethodPost, "/admin/users", map[string]any{"username": "x1", "email": "nope"}), http.StatusBadRequest)

	// The new user logs in through Keycloak: the token subject links to the provisioned row.
	nina := e.userWith("nina", sub, "memobrain-user")
	if nina.userID != u.ID {
		t.Fatalf("login created another row: %s vs %s", nina.userID, u.ID)
	}

	// Subscribe before the change: the suspension must reach the connected client.
	sup := e.app.Hub.Subscribe(uuid.MustParse(u.ID))
	defer e.app.Hub.Unsubscribe(sup)

	resp := root.json(http.MethodPost, "/admin/users/"+u.ID+":suspend", nil)
	expect(t, resp, http.StatusOK)
	if got := decode[adminUser](t, resp); got.Status != "suspended" {
		t.Fatalf("status %s", got.Status)
	}
	if e.kc.isEnabled(sub) {
		t.Fatal("the Keycloak account is still enabled")
	}
	// A valid token no longer works, at once (no waiting for the 30 s cache).
	r := nina.json(http.MethodGet, "/me", nil)
	expect(t, r, http.StatusForbidden)
	if code := problemCode(t, r); code != "USER_SUSPENDED" {
		t.Fatalf("code %s", code)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for done := false; !done; {
		batch, err := sup.Next(ctx)
		if err != nil {
			t.Fatalf("no account event: %v", err)
		}
		for _, ev := range batch {
			if ev.Kind == notify.KindAccount && ev.AccountKind == notify.AccountSuspended {
				done = true
			}
		}
	}

	resp = root.json(http.MethodPost, "/admin/users/"+u.ID+":activate", nil)
	expect(t, resp, http.StatusOK)
	if !e.kc.isEnabled(sub) {
		t.Fatal("the Keycloak account was not re-enabled")
	}
	expect(t, nina.json(http.MethodGet, "/me", nil), http.StatusOK)
}

func TestAdminCannotLockTheLastAdministratorOut(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	// Other tests share the database: make root the only active administrator.
	if _, err := e.db.Pool.Exec(context.Background(), "UPDATE users SET role='user' WHERE role='admin' AND id<>$1", root.uid()); err != nil {
		t.Fatal(err)
	}
	expect(t, root.json(http.MethodPost, "/admin/users/"+root.userID+":suspend", nil), http.StatusConflict)
	expect(t, root.json(http.MethodDelete, "/admin/users/"+root.userID, nil), http.StatusConflict)
	expect(t, root.json(http.MethodPut, "/admin/users/"+root.userID+"/role", map[string]any{"role": "user"}), http.StatusConflict)

	// A second administrator can be demoted by the first, but not the other way round by themselves.
	second := root.createUser("second", "second@memobrain.local", "admin")
	if second.Role != "admin" {
		t.Fatalf("role %s", second.Role)
	}
	resp := root.json(http.MethodPut, "/admin/users/"+second.ID+"/role", map[string]any{"role": "user"})
	expect(t, resp, http.StatusOK)
	if decode[adminUser](t, resp).Role != "user" {
		t.Fatal("role not changed")
	}
}

func TestAdminSetsQuotaAndWritesStopAtTheLimit(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	ada := e.user("ada")
	v := ada.createVault("Notes", "shared")

	resp := root.json(http.MethodPut, "/admin/users/"+ada.userID+"/quota", map[string]any{"quota_bytes": 10})
	expect(t, resp, http.StatusOK)
	if got := decode[adminUser](t, resp); got.QuotaBytes != 10 || got.QuotaBytesOverride == nil || *got.QuotaBytesOverride != 10 {
		t.Fatalf("quota: %+v", got)
	}
	// A write over the quota stops at the upload already (the blob alone does not fit).
	big := []byte("0123456789ABCDEF")
	if p := respProblem(t, ada.raw(http.MethodPut, "/vaults/"+v+"/blobs/"+hashOf(big), "application/octet-stream", big, nil)); p.Status != http.StatusRequestEntityTooLarge || p.Code != "QUOTA_EXCEEDED" {
		t.Fatalf("a write over the quota: %+v", p)
	}
	// Unlimited, then back to the default.
	expect(t, root.json(http.MethodPut, "/admin/users/"+ada.userID+"/quota", map[string]any{"quota_bytes": -1}), http.StatusOK)
	mustAccepted(t, ada.commit(v, create(newID(), "big.md", ada.putBlob(v, []byte("0123456789ABCDEF"))))[0])
	resp = root.json(http.MethodPut, "/admin/users/"+ada.userID+"/quota", map[string]any{})
	expect(t, resp, http.StatusOK)
	if got := decode[adminUser](t, resp); got.QuotaBytesOverride != nil || got.QuotaBytes != 5<<30 {
		t.Fatalf("reset: %+v", got)
	}
	expect(t, root.json(http.MethodPut, "/admin/users/"+ada.userID+"/quota", map[string]any{"quota_bytes": -5}), http.StatusBadRequest)

	// Bulk.
	bob := e.user("bob")
	resp = root.json(http.MethodPost, "/admin/storage/bulk-quota", map[string]any{"user_ids": []string{ada.userID, bob.userID}, "quota_bytes": 1 << 20})
	expect(t, resp, http.StatusOK)
	if n := decode[map[string]any](t, resp)["updated"]; n != float64(2) {
		t.Fatalf("updated %v", n)
	}
	if u, _ := e.app.Users.GetMe(context.Background(), bob.uid()); u.QuotaBytes != 1<<20 {
		t.Fatalf("bob's quota %d", u.QuotaBytes)
	}
}

func TestAdminListsUsersWithFilters(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	tag := uuid.NewString()[:8]
	a := root.createUser("zed-"+tag, "zed-"+tag+"@memobrain.local", "user")
	b := root.createUser("yan-"+tag, "yan-"+tag+"@memobrain.local", "user")
	expect(t, root.json(http.MethodPost, "/admin/users/"+b.ID+":suspend", nil), http.StatusOK)

	list := func(q string) (items []adminUser, total int) {
		resp := root.json(http.MethodGet, "/admin/users?"+q, nil)
		expect(t, resp, http.StatusOK)
		out := decode[struct {
			Items []adminUser `json:"items"`
			Total int         `json:"total"`
		}](t, resp)
		return out.Items, out.Total
	}
	if items, total := list("q=" + tag); total != 2 || len(items) != 2 {
		t.Fatalf("search: %d %v", total, items)
	}
	if items, _ := list("q=" + tag + "&status=suspended"); len(items) != 1 || items[0].ID != b.ID {
		t.Fatalf("suspended filter: %v", items)
	}
	if items, total := list("q=" + tag + "&limit=1&offset=1"); len(items) != 1 || total != 2 {
		t.Fatalf("paging: %d %v", total, items)
	}
	team := e.group("team", e.user("m1"))
	expect(t, root.json(http.MethodPut, "/admin/groups/"+team.String()+"/members/"+a.ID, map[string]any{"member_role": "member"}), http.StatusNoContent)
	if items, _ := list("group=" + team.String() + "&q=" + tag); len(items) != 1 || items[0].ID != a.ID {
		t.Fatalf("group filter: %v", items)
	}
	expect(t, root.json(http.MethodGet, "/admin/users?status=bogus", nil), http.StatusBadRequest)
}

func TestAdminDeletesAUserAndTheirVaultsEnterRetention(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	u := root.createUser("gone", "gone-"+uuid.NewString()[:6]+"@memobrain.local", "user")
	var sub string
	e.kc.mu.Lock()
	for s, spec := range e.kc.users {
		if spec.Username == "gone" {
			sub = s
		}
	}
	e.kc.mu.Unlock()
	gone := e.userWith("gone", sub, "memobrain-user")
	gone.createVault("Mine", "shared")

	expect(t, root.json(http.MethodDelete, "/admin/users/"+u.ID, nil), http.StatusNoContent)
	expect(t, root.json(http.MethodGet, "/admin/users/"+u.ID, nil), http.StatusNotFound)
	var deleted int
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT COUNT(*) FROM vaults WHERE owner_id=$1 AND deleted_at IS NOT NULL", u.ID).Scan(&deleted); err != nil || deleted != 1 {
		t.Fatalf("vaults in retention: %d %v", deleted, err)
	}
	expect(t, gone.json(http.MethodGet, "/me", nil), http.StatusForbidden)
	if e.kc.isEnabled(sub) {
		t.Fatal("the Keycloak account was not disabled")
	}
}

func TestAdminResetPasswordSessionsAndDevices(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	u := root.createUser("rita", "rita-"+uuid.NewString()[:6]+"@memobrain.local", "user")
	var sub string
	e.kc.mu.Lock()
	for s, spec := range e.kc.users {
		if spec.Username == "rita" {
			sub = s
		}
	}
	e.kc.sessions[sub] = []keycloak.Session{{ID: "s1", IPAddress: "10.0.0.1", Started: time.Now().Add(-time.Hour), LastAccess: time.Now(), Clients: []string{"memobrain-web"}}}
	e.kc.mu.Unlock()
	rita := e.userWith("rita", sub, "memobrain-user")
	_ = rita

	resp := root.json(http.MethodPost, "/admin/users/"+u.ID+":reset-password", nil)
	expect(t, resp, http.StatusOK)
	if !decode[map[string]any](t, resp)["email_sent"].(bool) || len(e.kc.resets) != 1 {
		t.Fatal("password reset not requested")
	}
	e.kc.mu.Lock()
	e.kc.emailOK = false
	e.kc.mu.Unlock()
	resp = root.json(http.MethodPost, "/admin/users/"+u.ID+":reset-password", nil)
	expect(t, resp, http.StatusOK)
	if decode[map[string]any](t, resp)["email_sent"].(bool) {
		t.Fatal("email_sent should be false when Keycloak cannot send")
	}

	resp = root.json(http.MethodGet, "/admin/users/"+u.ID+"/sessions", nil)
	expect(t, resp, http.StatusOK)
	if s := decode[[]map[string]any](t, resp); len(s) != 1 || s[0]["ip_address"] != "10.0.0.1" {
		t.Fatalf("sessions: %v", s)
	}
	resp = root.json(http.MethodGet, "/admin/users/"+u.ID+"/devices", nil)
	expect(t, resp, http.StatusOK)
	if d := decode[[]map[string]any](t, resp); len(d) != 1 {
		t.Fatalf("devices: %v", d)
	}
	rita.createVault("Metadata", "shared")
	resp = root.json(http.MethodGet, "/admin/users/"+u.ID+"/vaults", nil)
	expect(t, resp, http.StatusOK)
	if v := decode[[]map[string]any](t, resp); len(v) != 1 || v[0]["name"] != "Metadata" || v[0]["kind"] != "shared" {
		t.Fatalf("vaults: %v", v)
	}
}

func TestAdminGroupsAndConfigProfiles(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	bob := e.user("bob")

	resp := root.json(http.MethodPost, "/admin/groups", map[string]any{"name": "Engineers-" + uuid.NewString()[:6], "description": "Everyone"})
	expect(t, resp, http.StatusCreated)
	g := decode[map[string]any](t, resp)
	gid := g["id"].(string)
	expect(t, root.json(http.MethodPost, "/admin/groups", map[string]any{"name": g["name"]}), http.StatusConflict)
	expect(t, root.json(http.MethodPut, "/admin/groups/"+gid+"/members/"+bob.userID, map[string]any{"member_role": "manager"}), http.StatusNoContent)
	resp = root.json(http.MethodGet, "/admin/groups/"+gid+"/members", nil)
	expect(t, resp, http.StatusOK)
	if m := pageItems[map[string]any](t, resp); len(m) != 1 || m[0]["member_role"] != "manager" {
		t.Fatalf("members: %v", m)
	}
	resp = root.json(http.MethodGet, "/admin/groups/"+gid, nil)
	expect(t, resp, http.StatusOK)
	if decode[map[string]any](t, resp)["member_count"] != float64(1) {
		t.Fatal("member_count")
	}

	// A profile: validated against the schema.
	expect(t, root.json(http.MethodPost, "/admin/config-profiles", map[string]any{"name": "Bad", "config": map[string]any{"features": map[string]any{"sharing": "yes"}}}), http.StatusBadRequest)
	resp = root.json(http.MethodPost, "/admin/config-profiles", map[string]any{
		"name": "Eng-" + uuid.NewString()[:6], "config": map[string]any{"editor": map[string]any{"fontSize": 17}}, "locked_keys": []string{"editor.fontSize"},
	})
	expect(t, resp, http.StatusCreated)
	p := decode[map[string]any](t, resp)
	pid := p["id"].(string)
	if p["version"] != float64(1) {
		t.Fatalf("version %v", p["version"])
	}
	before, _ := bob.effective()
	expect(t, root.json(http.MethodPut, "/admin/groups/"+gid+"/config-profiles", map[string]any{"items": []map[string]any{{"profile_id": pid, "priority": 10}}}), http.StatusNoContent)
	after, _ := bob.effective()
	if sub(after.Config, "editor")["fontSize"] != float64(17) || after.Version <= before.Version {
		t.Fatalf("effective after assignment: %+v (before %d)", after, before.Version)
	}
	resp = root.json(http.MethodGet, "/admin/users/"+bob.userID+"/config/effective", nil)
	expect(t, resp, http.StatusOK)
	if sub(decode[map[string]any](t, resp)["config"].(map[string]any), "editor")["fontSize"] != float64(17) {
		t.Fatal("effective preview")
	}
	resp = root.json(http.MethodGet, "/admin/groups/"+gid+"/config-profiles", nil)
	expect(t, resp, http.StatusOK)
	if a := decode[[]map[string]any](t, resp); len(a) != 1 || a[0]["priority"] != float64(10) {
		t.Fatalf("assignments: %v", a)
	}

	// Edit: the version grows and the history keeps both; rolling back adds a third.
	resp = root.json(http.MethodPut, "/admin/config-profiles/"+pid, map[string]any{"name": p["name"], "config": map[string]any{"editor": map[string]any{"fontSize": 20}}})
	expect(t, resp, http.StatusOK)
	if decode[map[string]any](t, resp)["version"] != float64(2) {
		t.Fatal("version after update")
	}
	resp = root.json(http.MethodGet, "/admin/config-profiles/"+pid+"/versions", nil)
	expect(t, resp, http.StatusOK)
	vs := pageItems[map[string]any](t, resp)
	if len(vs) != 2 || vs[0]["version"] != float64(2) || vs[1]["version"] != float64(1) || vs[0]["config"] != nil {
		t.Fatalf("history: %v", vs)
	}
	resp = root.json(http.MethodPost, "/admin/config-profiles/"+pid+"/versions/1:restore", nil)
	expect(t, resp, http.StatusOK)
	restored := decode[map[string]any](t, resp)
	if restored["version"] != float64(3) || sub(restored["config"].(map[string]any), "editor")["fontSize"] != float64(17) {
		t.Fatalf("restore: %v", restored)
	}
	expect(t, root.json(http.MethodPost, "/admin/config-profiles/"+pid+"/versions/99:restore", nil), http.StatusNotFound)

	// Delete group and profile.
	expect(t, root.json(http.MethodDelete, "/admin/groups/"+gid, nil), http.StatusNoContent)
	expect(t, root.json(http.MethodGet, "/admin/groups/"+gid, nil), http.StatusNotFound)
	expect(t, root.json(http.MethodDelete, "/admin/config-profiles/"+pid, nil), http.StatusNoContent)
	expect(t, root.json(http.MethodGet, "/admin/config-profiles/"+pid, nil), http.StatusNotFound)
}

func TestAdminStorageSettingsAndOverview(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	resp := root.json(http.MethodGet, "/admin/settings/storage", nil)
	expect(t, resp, http.StatusOK)
	cur := decode[map[string]any](t, resp)
	if cur["default_quota_bytes"] != float64(5<<30) || cur["warn_percent"] != float64(80) {
		t.Fatalf("defaults: %v", cur)
	}
	bad := map[string]any{}
	for k, v := range cur {
		bad[k] = v
	}
	bad["warn_percent"], bad["critical_percent"] = 90, 85
	expect(t, root.json(http.MethodPut, "/admin/settings/storage", bad), http.StatusBadRequest)

	next := map[string]any{}
	for k, v := range cur {
		next[k] = v
	}
	next["default_quota_bytes"] = 1 << 30
	t.Cleanup(func() { _ = root.json(http.MethodPut, "/admin/settings/storage", cur) })
	expect(t, root.json(http.MethodPut, "/admin/settings/storage", next), http.StatusOK)
	if u, _ := e.app.Users.GetMe(context.Background(), root.uid()); u.QuotaBytes != 1<<30 {
		t.Fatalf("the new default does not apply: %d", u.QuotaBytes)
	}

	ada := e.user("ada")
	v := ada.createVault("Notes", "shared")
	expect(t, root.json(http.MethodPut, "/admin/users/"+ada.userID+"/quota", map[string]any{"quota_bytes": 100}), http.StatusOK)
	mustAccepted(t, ada.commit(v, create(newID(), "a.md", ada.putBlob(v, []byte(strings.Repeat("x", 96)))))[0])
	resp = root.json(http.MethodGet, "/admin/storage/overview", nil)
	expect(t, resp, http.StatusOK)
	ov := decode[struct {
		Total    int64 `json:"total_used_bytes"`
		Critical int   `json:"users_over_critical"`
		Warn     int   `json:"users_over_warn"`
		Users    int   `json:"user_count"`
		Top      []struct {
			Username string `json:"username"`
			Used     int64  `json:"used_bytes"`
			Quota    int64  `json:"quota_bytes"`
		} `json:"top_consumers"`
		Trend []map[string]any `json:"trend"`
	}](t, resp)
	if ov.Critical < 1 || ov.Warn < 1 || ov.Users < 2 || ov.Total < 96 || len(ov.Trend) == 0 {
		t.Fatalf("overview: %+v", ov)
	}
	found := false
	for _, c := range ov.Top {
		if c.Username == "ada" && c.Used == 96 && c.Quota == 100 {
			found = true
		}
	}
	if !found {
		t.Fatalf("ada missing from the top consumers: %+v", ov.Top)
	}
}

func TestAdminAuditTrail(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	u := root.createUser("audited", "audited-"+uuid.NewString()[:6]+"@memobrain.local", "user")
	expect(t, root.json(http.MethodPost, "/admin/users/"+u.ID+":suspend", nil), http.StatusOK)

	type page struct {
		Items []struct {
			ID         int64          `json:"id"`
			Action     string         `json:"action"`
			ActorName  string         `json:"actor_name"`
			TargetType string         `json:"target_type"`
			TargetID   string         `json:"target_id"`
			Details    map[string]any `json:"details"`
		} `json:"items"`
		Next string `json:"next_cursor"`
	}
	resp := root.json(http.MethodGet, "/admin/audit-log?target="+u.ID, nil)
	expect(t, resp, http.StatusOK)
	p := decode[page](t, resp)
	actions := map[string]bool{}
	for _, it := range p.Items {
		actions[it.Action] = true
		if it.ActorName != "root" || it.TargetType != "user" {
			t.Fatalf("entry: %+v", it)
		}
	}
	if !actions["user.create"] || !actions["user.suspend"] {
		t.Fatalf("actions: %v", actions)
	}

	// Filter by actor and action prefix, newest first, with a cursor.
	resp = root.json(http.MethodGet, "/admin/audit-log?actor="+root.userID+"&action=user.&limit=1", nil)
	expect(t, resp, http.StatusOK)
	first := decode[page](t, resp)
	if len(first.Items) != 1 || first.Next == "" || !strings.HasPrefix(first.Items[0].Action, "user.") {
		t.Fatalf("first page: %+v", first)
	}
	resp = root.json(http.MethodGet, "/admin/audit-log?actor="+root.userID+"&action=user.&limit=1&cursor="+first.Next, nil)
	expect(t, resp, http.StatusOK)
	second := decode[page](t, resp)
	if len(second.Items) != 1 || second.Items[0].ID >= first.Items[0].ID {
		t.Fatalf("second page: %+v", second)
	}
	expect(t, root.json(http.MethodGet, "/admin/audit-log?cursor=zzz", nil), http.StatusBadRequest)
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	resp = root.json(http.MethodGet, "/admin/audit-log?from="+strings.ReplaceAll(future, "+", "%2B"), nil)
	expect(t, resp, http.StatusOK)
	if got := decode[page](t, resp); len(got.Items) != 0 {
		t.Fatalf("a window in the future returned %d entries", len(got.Items))
	}

	resp = root.json(http.MethodGet, "/admin/audit-log.csv?actor="+root.userID, nil)
	expect(t, resp, http.StatusOK)
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("content type %q", ct)
	}
	rows, err := csv.NewReader(resp.Body).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) < 3 || rows[0][0] != "id" || rows[0][4] != "action" {
		t.Fatalf("csv header/rows: %v", rows[:1])
	}
}

func TestMaintenanceRecordsTheStorageSnapshot(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Notes", "shared")
	mustAccepted(t, ada.commit(v, create(newID(), "a.md", ada.putBlob(v, []byte("0123456789"))))[0])
	if err := e.app.Jobs().Maintain(context.Background()); err != nil {
		t.Fatal(err)
	}
	var total int64
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT total_bytes FROM storage_snapshots WHERE day = CURRENT_DATE").Scan(&total); err != nil || total < 10 {
		t.Fatalf("snapshot %d %v", total, err)
	}
}
