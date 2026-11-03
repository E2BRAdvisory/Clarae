//go:build integration

package integration

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// pageOf is one page of a paginated list.
type pageOf struct {
	Items      []map[string]any `json:"items"`
	NextCursor *string          `json:"next_cursor"`
}

// pages reads every page of path (which may already have a query) with the
// given limit and returns the pages in order; it fails on an endless list.
func (c *client) pages(path string, limit int) []pageOf {
	c.e.t.Helper()
	return c.pagesFrom(path, limit, "")
}

// pagesFrom is pages starting at cursor.
func (c *client) pagesFrom(path string, limit int, cursor string) []pageOf {
	c.e.t.Helper()
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	var out []pageOf
	for range 1000 {
		q := fmt.Sprintf("%s%slimit=%d", path, sep, limit)
		if cursor != "" {
			q += "&cursor=" + url.QueryEscape(cursor)
		}
		resp := c.json(http.MethodGet, q, nil)
		expect(c.e.t, resp, http.StatusOK)
		p := decode[pageOf](c.e.t, resp)
		if p.Items == nil || len(p.Items) > limit {
			c.e.t.Fatalf("%s: page of %d items (limit %d)", q, len(p.Items), limit)
		}
		out = append(out, p)
		if p.NextCursor == nil {
			return out
		}
		cursor = *p.NextCursor
	}
	c.e.t.Fatalf("%s: no last page", path)
	return nil
}

// field lists one field of the items of every page, failing on a duplicate.
func field(t *testing.T, ps []pageOf, key string) []string {
	t.Helper()
	var out []string
	seen := map[string]bool{}
	for _, p := range ps {
		for _, it := range p.Items {
			v := fmt.Sprint(it[key])
			if seen[v] {
				t.Fatalf("%s %s listed twice", key, v)
			}
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

func TestPaginatedAdminGroupsAndMembers(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	tag := uuid.NewString()[:6]
	var mine []string
	for _, n := range []string{"pg-b", "PG-a", "pg-g", "pg-d", "pg-C", "pg-e"} {
		name := n + "-" + tag
		expect(t, root.json(http.MethodPost, "/admin/groups", map[string]any{"name": name}), http.StatusCreated)
		mine = append(mine, name)
	}

	// The longest name the contract allows (100 characters), most of them of 4 bytes in
	// UTF-8, still fits in a cursor.
	long := "pg-f" + strings.Repeat("\U0001F600", 89) + "-" + tag
	expect(t, root.json(http.MethodPost, "/admin/groups", map[string]any{"name": long}), http.StatusCreated)
	// Every group once, by name (case-insensitively), each page ending on a cursor.
	all := field(t, root.pages("/admin/groups", 1), "name")
	var got []string
	for _, n := range all {
		if strings.HasSuffix(n, "-"+tag) {
			got = append(got, n)
		}
	}
	if want := []string{"PG-a-" + tag, "pg-b-" + tag, "pg-C-" + tag, "pg-d-" + tag, "pg-e-" + tag, long, "pg-g-" + tag}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("groups %v, want %v", got, want)
	}

	// Without parameters: the first page with the default size (and every group here fits).
	resp := root.json(http.MethodGet, "/admin/groups", nil)
	expect(t, resp, http.StatusOK)
	if p := decode[pageOf](t, resp); len(p.Items) != min(len(all), 100) {
		t.Fatalf("default page: %d items of %d", len(p.Items), len(all))
	}

	// A group created behind the cursor between two pages is not listed twice nor
	// skipped when it sorts after the cursor.
	first := decode[pageOf](t, root.json(http.MethodGet, "/admin/groups?limit=1", nil))
	if first.NextCursor == nil {
		t.Fatal("no next page")
	}
	late := "zz-pg-late-" + tag
	expect(t, root.json(http.MethodPost, "/admin/groups", map[string]any{"name": late}), http.StatusCreated)
	rest := root.pagesFrom("/admin/groups", 3, *first.NextCursor)
	names := append([]string{fmt.Sprint(first.Items[0]["name"])}, field(t, rest, "name")...)
	if strings.Count(strings.Join(names, "\n"), late) != 1 {
		t.Fatalf("the group created while paging: %v", names)
	}

	// Members of a group, by username, in pages of 2.
	gid := e.group("pg-members", e.user("pm-c"), e.user("pm-a"), e.user("PM-e"), e.user("pm-b"), e.user("pm-d")).String()
	users := field(t, root.pages("/admin/groups/"+gid+"/members", 2), "username")
	if strings.Join(users, ",") != "pm-a,pm-b,pm-c,pm-d,PM-e" {
		t.Fatalf("members %v", users)
	}

	// Every page is authorized: a cursor does not open the list to a non-admin.
	cur := decode[pageOf](t, root.json(http.MethodGet, "/admin/groups/"+gid+"/members?limit=1", nil)).NextCursor
	if cur == nil {
		t.Fatal("no next page of members")
	}
	bob := e.user("bob")
	expect(t, bob.json(http.MethodGet, "/admin/groups/"+gid+"/members?cursor="+url.QueryEscape(*cur), nil), http.StatusForbidden)
	// A cursor of another list, or no cursor at all, is a validation error; so is a limit out of range.
	expect(t, root.json(http.MethodGet, "/admin/groups?cursor="+url.QueryEscape(*cur), nil), http.StatusBadRequest)
	expect(t, root.json(http.MethodGet, "/admin/groups/"+gid+"/members?cursor=not-a-cursor", nil), http.StatusBadRequest)
	expect(t, root.json(http.MethodGet, "/admin/groups?limit=501", nil), http.StatusBadRequest)
	expect(t, root.json(http.MethodGet, "/admin/groups?limit=0", nil), http.StatusBadRequest)
}

func TestPaginatedProfileVersions(t *testing.T) {
	e := newEnv(t)
	root := e.admin("root")
	name := "pv-" + uuid.NewString()[:6]
	resp := root.json(http.MethodPost, "/admin/config-profiles", map[string]any{"name": name, "config": map[string]any{"editor": map[string]any{"fontSize": 11}}})
	expect(t, resp, http.StatusCreated)
	pid := decode[map[string]any](t, resp)["id"].(string)
	for size := 12; size <= 14; size++ {
		expect(t, root.json(http.MethodPut, "/admin/config-profiles/"+pid, map[string]any{"name": name, "config": map[string]any{"editor": map[string]any{"fontSize": size}}}), http.StatusOK)
	}

	ps := root.pages("/admin/config-profiles/"+pid+"/versions", 3)
	if len(ps) != 2 || strings.Join(field(t, ps, "version"), ",") != "4,3,2,1" {
		t.Fatalf("history pages: %+v", ps)
	}
	for _, p := range ps {
		for _, v := range p.Items {
			if _, ok := v["config"]; ok {
				t.Fatalf("the list carries the configuration: %v", v)
			}
		}
	}

	// One version, with its configuration, on demand.
	resp = root.json(http.MethodGet, "/admin/config-profiles/"+pid+"/versions/2", nil)
	expect(t, resp, http.StatusOK)
	v := decode[map[string]any](t, resp)
	if v["version"] != float64(2) || sub(v["config"].(map[string]any), "editor")["fontSize"] != float64(12) || v["locked_keys"] == nil {
		t.Fatalf("version 2: %v", v)
	}
	expect(t, root.json(http.MethodGet, "/admin/config-profiles/"+pid+"/versions/9", nil), http.StatusNotFound)
	expect(t, root.json(http.MethodGet, "/admin/config-profiles/"+uuid.NewString()+"/versions/1", nil), http.StatusNotFound)
	expect(t, root.json(http.MethodGet, "/admin/config-profiles/"+uuid.NewString()+"/versions", nil), http.StatusNotFound)
	expect(t, root.json(http.MethodGet, "/admin/config-profiles/"+pid+"/versions?limit=201", nil), http.StatusBadRequest)
	bob := e.user("bob")
	expect(t, bob.json(http.MethodGet, "/admin/config-profiles/"+pid+"/versions/2", nil), http.StatusForbidden)
}

func TestPaginatedShares(t *testing.T) {
	e := newEnv(t)
	ada, bob, carol := e.user("ada"), e.user("bob"), e.user("carol")
	vault := ada.createVault("Paged", "shared")
	ada.seed(vault, map[string]string{"A/a.md": "a", "B/b.md": "b", "C/c.md": "c"})
	var made []string
	for _, f := range []string{"A", "B", "C"} {
		made = append(made, ada.share(vault, "folder", f, grantTo("user", bob.userID, "viewer")).id())
	}
	newestFirst := strings.Join([]string{made[2], made[1], made[0]}, ",")

	if got := strings.Join(field(t, ada.pages("/shares?scope=owned", 2), "id"), ","); got != newestFirst {
		t.Fatalf("owned %s, want %s", got, newestFirst)
	}
	if got := strings.Join(field(t, bob.pages("/shares?scope=received", 1), "id"), ","); got != newestFirst {
		t.Fatalf("received %s, want %s", got, newestFirst)
	}
	// Nothing accepted yet: no mounts, on a single empty page.
	if ps := bob.pages("/shared-with-me", 1); len(ps) != 1 || len(ps[0].Items) != 0 {
		t.Fatalf("mounts before accepting: %+v", ps)
	}
	bob.accept(made[0])
	bob.accept(made[2])
	if got := strings.Join(field(t, bob.pages("/shared-with-me", 1), "share_id"), ","); got != made[2]+","+made[0] {
		t.Fatalf("mounts %s", got)
	}

	// A cursor is a position, never a grant: carol going on from bob's cursor sees nothing of his.
	cur := decode[pageOf](t, bob.json(http.MethodGet, "/shares?scope=received&limit=1", nil)).NextCursor
	if cur == nil {
		t.Fatal("no next page of received shares")
	}
	resp := carol.json(http.MethodGet, "/shares?scope=received&cursor="+url.QueryEscape(*cur), nil)
	expect(t, resp, http.StatusOK)
	if p := decode[pageOf](t, resp); len(p.Items) != 0 || p.NextCursor != nil {
		t.Fatalf("carol with bob's cursor: %+v", p)
	}
	// The cursor of one list is refused by another.
	expect(t, bob.json(http.MethodGet, "/shares?scope=owned&cursor="+url.QueryEscape(*cur), nil), http.StatusBadRequest)
	expect(t, bob.json(http.MethodGet, "/shared-with-me?cursor="+url.QueryEscape(*cur), nil), http.StatusBadRequest)

	// A share revoked between two pages is not listed, nor does it break the walk.
	first := decode[pageOf](t, ada.json(http.MethodGet, "/shares?scope=owned&limit=1", nil))
	expect(t, ada.json(http.MethodDelete, "/shares/"+made[1], nil), http.StatusNoContent)
	rest := ada.pagesFrom("/shares?scope=owned", 1, *first.NextCursor)
	if got := field(t, rest, "id"); strings.Join(got, ",") != made[0] {
		t.Fatalf("after the revoke: %v", got)
	}
}
