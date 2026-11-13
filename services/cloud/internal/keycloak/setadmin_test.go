package keycloak

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
)

// roleRealm is a realm with a fixed set of realm roles and the roles one user holds.
type roleRealm struct {
	mu      sync.Mutex
	realm   []string // names of the realm roles
	held    []string // names the user holds
	granted []string // names of the POSTed mappings
	revoked []string // names of the DELETEd mappings
}

func (f *roleRealm) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.HasSuffix(r.URL.Path, "/protocol/openid-connect/token") {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "tok", "expires_in": 300})
		return
	}
	type role struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	list := func(names []string) {
		out := []role{}
		for _, n := range names {
			out = append(out, role{ID: "id-" + n, Name: n})
		}
		_ = json.NewEncoder(w).Encode(out)
	}
	names := func() []string {
		var rs []role
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &rs)
		var out []string
		for _, x := range rs {
			out = append(out, x.Name)
		}
		return out
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /admin/realms/r/users/u/role-mappings/realm/available":
		var avail []string
		for _, n := range f.realm {
			if !slices.Contains(f.held, n) {
				avail = append(avail, n)
			}
		}
		list(avail)
	case "GET /admin/realms/r/users/u/role-mappings/realm":
		list(f.held)
	case "POST /admin/realms/r/users/u/role-mappings/realm":
		f.granted = append(f.granted, names()...)
		w.WriteHeader(http.StatusNoContent)
	case "DELETE /admin/realms/r/users/u/role-mappings/realm":
		f.revoked = append(f.revoked, names()...)
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func setAdminClient(t *testing.T, f *roleRealm, adminRoles []string) Admin {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return New(Config{BaseURL: srv.URL, Realm: "r", ClientID: "svc", ClientSecret: "s", AdminRoles: adminRoles})
}

// A realm imported by 1.x only has memobrain-admin: the console must still be able to promote
// and demote, which is the compatibility the double role name exists for.
func TestSetAdminOnARealmWithOnlyTheOldRole(t *testing.T) {
	f := &roleRealm{realm: []string{"memobrain-user", "memobrain-admin"}}
	kc := setAdminClient(t, f, nil) // the default list
	ctx := context.Background()

	if err := kc.SetAdmin(ctx, "u", true); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.granted, []string{"memobrain-admin"}) {
		t.Fatalf("granted %v, want [memobrain-admin]", f.granted)
	}

	f.held = []string{"memobrain-user", "memobrain-admin"}
	if err := kc.SetAdmin(ctx, "u", false); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.revoked, []string{"memobrain-admin"}) {
		t.Fatalf("revoked %v, want [memobrain-admin]", f.revoked)
	}
}

func TestSetAdminOnARealmWithTheNewRole(t *testing.T) {
	f := &roleRealm{realm: []string{"clarae-user", "clarae-admin"}}
	kc := setAdminClient(t, f, nil)
	if err := kc.SetAdmin(context.Background(), "u", true); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.granted, []string{"clarae-admin"}) {
		t.Fatalf("granted %v, want [clarae-admin]", f.granted)
	}
}

// A realm that has both names (a rename under way) gets the first one of the list on a grant,
// and a revoke leaves the user with neither.
func TestSetAdminWithBothRoles(t *testing.T) {
	f := &roleRealm{realm: []string{"memobrain-admin", "clarae-admin"}}
	kc := setAdminClient(t, f, nil)
	ctx := context.Background()
	if err := kc.SetAdmin(ctx, "u", true); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.granted, []string{"clarae-admin"}) {
		t.Fatalf("granted %v, want only the first role of the list", f.granted)
	}
	f.held = []string{"memobrain-admin", "clarae-admin"}
	if err := kc.SetAdmin(ctx, "u", false); err != nil {
		t.Fatal(err)
	}
	slices.Sort(f.revoked)
	if !slices.Equal(f.revoked, []string{"clarae-admin", "memobrain-admin"}) {
		t.Fatalf("revoked %v, want both", f.revoked)
	}
}

func TestSetAdminIsIdempotentAndReportsAMissingRole(t *testing.T) {
	ctx := context.Background()

	f := &roleRealm{realm: []string{"memobrain-admin"}, held: []string{"memobrain-admin"}}
	if err := setAdminClient(t, f, nil).SetAdmin(ctx, "u", true); err != nil || len(f.granted) != 0 {
		t.Fatalf("already an administrator: err %v, granted %v", err, f.granted)
	}

	f = &roleRealm{realm: []string{"clarae-user"}}
	err := setAdminClient(t, f, nil).SetAdmin(ctx, "u", true)
	if err == nil || !strings.Contains(err.Error(), "clarae-admin") || !strings.Contains(err.Error(), "memobrain-admin") {
		t.Fatalf("a realm without any admin role: got %v, want an error naming the roles", err)
	}

	f = &roleRealm{realm: []string{"clarae-admin"}}
	if err := setAdminClient(t, f, nil).SetAdmin(ctx, "u", false); err != nil || len(f.revoked) != 0 {
		t.Fatalf("revoke from a plain user: err %v, revoked %v", err, f.revoked)
	}
}

func TestSetAdminHonoursAnExplicitRoleList(t *testing.T) {
	f := &roleRealm{realm: []string{"clarae-admin", "ops"}}
	kc := setAdminClient(t, f, []string{"ops"})
	if err := kc.SetAdmin(context.Background(), "u", true); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(f.granted, []string{"ops"}) {
		t.Fatalf("granted %v, want [ops]", f.granted)
	}
}
