//go:build integration

package integration

import (
	"context"
	"net/http"
	"testing"

	"memobrain/services/cloud/internal/settings"
)

// TestListVaultsIncludeDeleted covers GET /vaults?include_deleted=true (ADR-0037):
// the owner's restorable soft-deleted vaults are listed with deleted_at, the
// default stays unchanged, vaults past the retention period and other users'
// vaults never appear, and a restored vault is listed as live again.
func TestListVaultsIncludeDeleted(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	live := ada.createVault("Live", "shared")
	gone := ada.createVault("Gone", "shared")
	old := ada.createVault("Old", "shared")
	bobs := bob.createVault("Bob's", "shared")
	for _, v := range []string{gone, old} {
		expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)
	}
	expect(t, bob.json(http.MethodDelete, "/vaults/"+bobs, nil), http.StatusNoContent)
	// "Old" was deleted before the retention period (30 days by default).
	if _, err := e.db.Pool.Exec(context.Background(), `UPDATE vaults SET deleted_at = now() - interval '31 days' WHERE id = $1`, old); err != nil {
		t.Fatal(err)
	}

	list := func(c *client, query string) map[string]map[string]any {
		t.Helper()
		resp := c.json(http.MethodGet, "/vaults"+query, nil)
		expect(t, resp, http.StatusOK)
		body := decode[map[string]any](t, resp)
		out := map[string]map[string]any{}
		for _, it := range body["items"].([]any) {
			v := it.(map[string]any)
			out[v["id"].(string)] = v
		}
		return out
	}

	def := list(ada, "")
	if len(def) != 1 || def[live] == nil {
		t.Fatalf("default list: %v", def)
	}
	if got := list(ada, "?include_deleted=false"); len(got) != 1 || got[live] == nil {
		t.Fatalf("include_deleted=false: %v", got)
	}
	all := list(ada, "?include_deleted=true")
	if len(all) != 2 || all[live] == nil || all[gone] == nil {
		t.Fatalf("include_deleted=true: %v", all)
	}
	if all[gone]["deleted_at"] == nil || all[live]["deleted_at"] != nil {
		t.Fatalf("deleted_at: live %v, gone %v", all[live]["deleted_at"], all[gone]["deleted_at"])
	}
	if got := list(bob, "?include_deleted=true"); len(got) != 1 || got[bobs] == nil {
		t.Fatalf("bob: %v", got)
	}

	// The retention period follows the setting, like restore does.
	ctx := context.Background()
	prev, had, err := settings.Get(ctx, e.db.Pool, "vaults.deleted_retention_days")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if had {
			_ = settings.Set(context.Background(), e.db.Pool, "vaults.deleted_retention_days", prev, nil)
		} else {
			_, _ = e.db.Pool.Exec(context.Background(), `DELETE FROM settings WHERE key = 'vaults.deleted_retention_days'`)
		}
	})
	if err := settings.Set(ctx, e.db.Pool, "vaults.deleted_retention_days", []byte("60"), nil); err != nil {
		t.Fatal(err)
	}
	if got := list(ada, "?include_deleted=true"); len(got) != 3 || got[old] == nil {
		t.Fatalf("with 60 days of retention: %v", got)
	}

	expect(t, ada.json(http.MethodPost, "/vaults/"+gone+":restore", nil), http.StatusOK)
	if got := list(ada, ""); len(got) != 2 || got[gone] == nil || got[gone]["deleted_at"] != nil {
		t.Fatalf("after restore: %v", got)
	}
}
