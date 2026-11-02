//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// Shares created by a manager (ADR-0041 §8) and the reserved group manager role (§9).

// createShare posts a share and returns the response, whatever its status.
func (c *client) createShare(body map[string]any) *http.Response {
	c.e.t.Helper()
	if _, ok := body["display_name"]; !ok {
		body["display_name"] = "Delegated"
	}
	return c.json(http.MethodPost, "/shares", body)
}

func ownedIDs(t *testing.T, c *client) map[string]shareView {
	t.Helper()
	out := map[string]shareView{}
	for _, s := range decode[[]shareView](t, c.json(http.MethodGet, "/shares?scope=owned", nil)) {
		out[s.id()] = s
	}
	return out
}

func TestManagerCreatesSharesInsideTheirScope(t *testing.T) {
	e, ada, bob, carol, vault, ids, _ := sharedFixture(t)
	eve := e.user("eve")
	alfa := ada.share(vault, "folder", "Projects/Alfa", grantTo("user", bob.userID, "manager"))
	bob.accept(alfa.id())

	// Inside the managed folder: a subfolder (case and NFC follow path_key), the folder itself, a document below it.
	resp := bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "projects/alfa/sub",
		"grants": []map[string]any{grantTo("user", carol.userID, "editor"), grantTo("user", eve.userID, "manager")}})
	expect(t, resp, http.StatusCreated)
	sub := decode[shareView](t, resp)
	if sub["my_permission"] != "manager" || sub["my_status"] != "accepted" || sub["owner_id"] != ada.userID || sub["grants"] == nil {
		t.Fatalf("the manager sees the share they created as its manager: %v", sub)
	}
	same := bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa"})
	expect(t, same, http.StatusCreated)
	doc := bob.createShare(map[string]any{"vault_id": vault, "resource_type": "file", "file_id": ids["Projects/Alfa/plan.md"]})
	expect(t, doc, http.StatusCreated)
	docID := decode[shareView](t, doc).id()

	// created_by is the manager, the audit names them and the share they went through.
	var createdBy string
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT created_by::text FROM shares WHERE id = $1", sub.id()).Scan(&createdBy); err != nil || createdBy != bob.userID {
		t.Fatalf("created_by %q, %v", createdBy, err)
	}
	var actor, details string
	if err := e.db.Pool.QueryRow(context.Background(),
		"SELECT actor_id::text, details::text FROM audit_log WHERE action = 'share.create' AND target_id = $1", sub.id()).Scan(&actor, &details); err != nil {
		t.Fatal(err)
	}
	var d map[string]any
	_ = json.Unmarshal([]byte(details), &d)
	if actor != bob.userID || d["via_share"] != alfa.id() {
		t.Fatalf("audit: actor %s details %s", actor, details)
	}

	// The recipient of the delegated share syncs it like any other.
	carol.accept(sub.id())
	items, _, _, code := carol.scopedChanges(vault, sub.id(), 0)
	if code != http.StatusOK || len(items) != 1 || items[0]["path"] != "a.md" {
		t.Fatalf("carol through the delegated share: %d %v", code, items)
	}

	// Outside the managed folder: a sibling, the parent, the whole vault, a document elsewhere.
	for _, body := range []map[string]any{
		{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Beta"},
		{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects"},
		{"vault_id": vault, "resource_type": "vault"},
		{"vault_id": vault, "resource_type": "file", "file_id": ids["root.md"]},
	} {
		resp := bob.createShare(body)
		expect(t, resp, http.StatusForbidden)
		if c := problemCode(t, resp); c != "FORBIDDEN" {
			t.Errorf("%v: code %s", body, c)
		}
	}
	// Grants are capped at manager: "owner" is not a level anyone can give.
	expect(t, bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa/sub",
		"grants": []map[string]any{grantTo("user", carol.userID, "owner")}}), http.StatusBadRequest)
	// The owner is never a grantee, not even through a manager.
	expect(t, bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa/sub",
		"grants": []map[string]any{grantTo("user", ada.userID, "viewer")}}), http.StatusBadRequest)

	// The manager changes what they created, but only the owner revokes it.
	expect(t, bob.json(http.MethodPatch, "/shares/"+sub.id(), map[string]any{"display_name": "Sub, renamed"}), http.StatusOK)
	expect(t, bob.json(http.MethodPut, "/shares/"+sub.id()+"/grants/user/"+carol.userID, map[string]any{"permission": "viewer"}), http.StatusOK)
	expect(t, bob.json(http.MethodDelete, "/shares/"+sub.id(), nil), http.StatusForbidden)
	expect(t, ada.json(http.MethodDelete, "/shares/"+docID, nil), http.StatusNoContent)

	// Both see the delegated shares among theirs; the owner as owner.
	if l := ownedIDs(t, bob); l[sub.id()] == nil || l[alfa.id()] == nil {
		t.Fatalf("bob's shares: %v", l)
	}
	if l := ownedIDs(t, ada); l[sub.id()] == nil || l[sub.id()]["my_permission"] != "manager" {
		t.Fatalf("ada's shares: %v", l)
	}
	// An editor of the delegated share manages nothing of it.
	expect(t, carol.json(http.MethodPatch, "/shares/"+sub.id(), map[string]any{"display_name": "x"}), http.StatusForbidden)

	// The manager loses the grant: no more creation, no more management of what they created,
	// which stays with the vault (its owner manages it, its recipients keep their access).
	expect(t, ada.json(http.MethodDelete, "/shares/"+alfa.id()+"/grants/user/"+bob.userID, nil), http.StatusNoContent)
	expect(t, bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa/sub"}), http.StatusNotFound)
	expect(t, bob.json(http.MethodPatch, "/shares/"+sub.id(), map[string]any{"display_name": "x"}), http.StatusNotFound)
	if l := ownedIDs(t, bob); l[sub.id()] != nil {
		t.Fatalf("a former manager no longer lists the share: %v", l)
	}
	if _, _, _, code := carol.scopedChanges(vault, sub.id(), 0); code != http.StatusOK {
		t.Fatalf("the delegated share outlives the manager's grant: %d", code)
	}
	expect(t, ada.json(http.MethodPatch, "/shares/"+sub.id(), map[string]any{"display_name": "Kept"}), http.StatusOK)
	// The owner still creates anywhere.
	expect(t, ada.createShare(map[string]any{"vault_id": vault, "resource_type": "vault"}), http.StatusCreated)
}

func TestManagerCreationNeedsALiveAcceptedManagerGrant(t *testing.T) {
	e, ada, bob, carol, vault, _, group := sharedFixture(t)
	eve := e.user("eve")
	whole := ada.share(vault, "vault", "", grantTo("user", bob.userID, "manager"), grantTo("user", eve.userID, "manager"), grantTo("user", carol.userID, "editor"))
	body := func() map[string]any {
		return map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Beta"}
	}

	// A pending manager grant gives nothing; an editor grant gives nothing.
	expect(t, bob.createShare(body()), http.StatusNotFound)
	carol.accept(whole.id())
	expect(t, carol.createShare(body()), http.StatusNotFound)

	// Accepted on a vault share: anything in the vault, the vault itself included.
	bob.accept(whole.id())
	expect(t, bob.createShare(body()), http.StatusCreated)
	expect(t, bob.createShare(map[string]any{"vault_id": vault, "resource_type": "vault"}), http.StatusCreated)

	// An expired share stops the delegation.
	e.exec("UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1", whole.id())
	expect(t, bob.createShare(body()), http.StatusNotFound)
	// A revoked one too.
	e.exec("UPDATE shares SET expires_at = NULL WHERE id = $1", whole.id())
	eve.accept(whole.id())
	expect(t, eve.createShare(body()), http.StatusCreated)
	expect(t, ada.json(http.MethodDelete, "/shares/"+whole.id(), nil), http.StatusNoContent)
	expect(t, eve.createShare(body()), http.StatusNotFound)

	// A manager grant through a group counts once the group accepted it.
	beta := ada.share(vault, "folder", "Projects/Beta", grantTo("group", group.String(), "manager"))
	expect(t, bob.createShare(body()), http.StatusNotFound)
	carol.accept(beta.id())
	expect(t, bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Beta",
		"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}), http.StatusCreated)
	expect(t, bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa"}), http.StatusForbidden)
}

func TestManagerCannotSharePrivateVaults(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	private := ada.createPrivateVault("Diary")
	shared := ada.createVault("Notes", "shared")
	ada.seed(shared, map[string]string{"a.md": "a"})
	sh := ada.share(shared, "vault", "", grantTo("user", bob.userID, "manager"))
	bob.accept(sh.id())
	// Managing a share of another vault of the same owner says nothing about the private one (D-02).
	expect(t, bob.createShare(map[string]any{"vault_id": private, "resource_type": "vault"}), http.StatusNotFound)
	resp := ada.createShare(map[string]any{"vault_id": private, "resource_type": "vault"})
	expect(t, resp, http.StatusConflict)
	if c := problemCode(t, resp); c != "VAULT_ENCRYPTED" {
		t.Fatalf("code %s", c)
	}
}

// ADR-0041 §8: a manager gives nothing to themselves, directly or through a group they belong
// to, and keeps no grant on what they created once they stop managing the share around it:
// revocation and expiry of their manager grant are the owner's to decide.
func TestManagerKeepsNoGrantOfTheirOwnOnWhatTheyCreated(t *testing.T) {
	e, ada, bob, _, vault, _, group := sharedFixture(t)
	eve := e.user("eve")
	alfa := ada.share(vault, "folder", "Projects/Alfa", grantTo("user", bob.userID, "manager"), grantTo("user", eve.userID, "manager"))
	bob.accept(alfa.id())
	eve.accept(alfa.id())
	sub := map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa/sub"}

	// Not at creation, not later, not on the share they manage by grant either.
	for _, g := range []map[string]any{grantTo("user", bob.userID, "manager"), grantTo("group", group.String(), "viewer")} {
		resp := bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa/sub", "grants": []map[string]any{g}})
		expect(t, resp, http.StatusForbidden)
		if c := problemCode(t, resp); c != "FORBIDDEN" {
			t.Fatalf("%v: code %s", g, c)
		}
	}
	sub["grants"] = []map[string]any{grantTo("user", eve.userID, "manager")}
	resp := bob.createShare(sub)
	expect(t, resp, http.StatusCreated)
	derived := decode[shareView](t, resp).id()
	eve.accept(derived)
	expect(t, bob.json(http.MethodPut, "/shares/"+derived+"/grants/user/"+bob.userID, map[string]any{"permission": "editor"}), http.StatusForbidden)
	expect(t, bob.json(http.MethodPut, "/shares/"+derived+"/grants/group/"+group.String(), map[string]any{"permission": "viewer"}), http.StatusForbidden)
	expect(t, bob.json(http.MethodPut, "/shares/"+alfa.id()+"/grants/group/"+group.String(), map[string]any{"permission": "viewer"}), http.StatusForbidden)

	// Another manager of that share may grant him; so may the owner, on a second share he created.
	expect(t, eve.json(http.MethodPut, "/shares/"+derived+"/grants/user/"+bob.userID, map[string]any{"permission": "editor"}), http.StatusOK)
	bob.accept(derived)
	resp = bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Alfa", "display_name": "Alfa again"})
	expect(t, resp, http.StatusCreated)
	again := decode[shareView](t, resp).id()
	expect(t, ada.json(http.MethodPut, "/shares/"+again+"/grants/user/"+bob.userID, map[string]any{"permission": "viewer"}), http.StatusOK)
	bob.accept(again)
	for _, id := range []string{derived, again} {
		if _, _, _, code := bob.scopedChanges(vault, id, 0); code != http.StatusOK {
			t.Fatalf("bob through %s while managing: %d", id, code)
		}
	}

	// The owner takes the manager grant: the grant eve gave him on what he created goes
	// with it, the one the owner gave stays.
	expect(t, ada.json(http.MethodDelete, "/shares/"+alfa.id()+"/grants/user/"+bob.userID, nil), http.StatusNoContent)
	if _, _, _, code := bob.scopedChanges(vault, derived, 0); code != http.StatusNotFound {
		t.Fatalf("bob keeps the share he created through another manager's grant: %d", code)
	}
	expect(t, bob.json(http.MethodGet, "/shares/"+derived, nil), http.StatusNotFound)
	if _, _, _, code := bob.scopedChanges(vault, again, 0); code != http.StatusOK {
		t.Fatalf("the owner's grant must stay: %d", code)
	}
	for _, g := range decode[shareView](t, ada.json(http.MethodGet, "/shares/"+derived, nil))["grants"].([]any) {
		if g.(map[string]any)["principal_id"] == bob.userID {
			t.Fatalf("bob's grant on %s is still listed: %v", derived, g)
		}
	}
}

// The same holds when the manager grant goes through a group (a member leaving it) or with
// the share itself (revoked).
func TestManagerGrantLostThroughAGroupOrARevocation(t *testing.T) {
	e, ada, bob, carol, vault, _, group := sharedFixture(t)
	eve := e.user("eve")
	alfa := ada.share(vault, "folder", "Projects/Alfa", grantTo("group", group.String(), "manager"), grantTo("user", eve.userID, "manager"))
	carol.accept(alfa.id())
	eve.accept(alfa.id())
	created := func(c *client, prefix string) string {
		t.Helper()
		resp := c.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": prefix,
			"grants": []map[string]any{grantTo("user", eve.userID, "manager")}})
		expect(t, resp, http.StatusCreated)
		id := decode[shareView](t, resp).id()
		eve.accept(id)
		expect(t, eve.json(http.MethodPut, "/shares/"+id+"/grants/user/"+c.userID, map[string]any{"permission": "editor"}), http.StatusOK)
		c.accept(id)
		if _, _, _, code := c.scopedChanges(vault, id, 0); code != http.StatusOK {
			t.Fatalf("before: %d", code)
		}
		return id
	}
	byBob, byCarol := created(bob, "Projects/Alfa/sub"), created(carol, "Projects/Alfa")

	if err := e.app.Groups.RemoveMember(context.Background(), ada.uid(), group, bob.uid()); err != nil {
		t.Fatal(err)
	}
	if _, _, _, code := bob.scopedChanges(vault, byBob, 0); code != http.StatusNotFound {
		t.Fatalf("bob left the managing group: %d", code)
	}
	if _, _, _, code := carol.scopedChanges(vault, byCarol, 0); code != http.StatusOK {
		t.Fatalf("carol still manages: %d", code)
	}
	expect(t, ada.json(http.MethodDelete, "/shares/"+alfa.id(), nil), http.StatusNoContent)
	if _, _, _, code := carol.scopedChanges(vault, byCarol, 0); code != http.StatusNotFound {
		t.Fatalf("the managed share was revoked: %d", code)
	}
}

// An expired share gives nothing to anyone but its owner (§3.3.2): its manager cannot
// change it, and so cannot bring it back.
func TestExpiredShareIsChangedOnlyByItsOwner(t *testing.T) {
	e, ada, bob, carol, vault, _, _ := sharedFixture(t)
	sh := ada.share(vault, "vault", "", grantTo("user", bob.userID, "manager"), grantTo("user", carol.userID, "viewer"))
	bob.accept(sh.id())
	e.exec("UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1", sh.id())
	later := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	for _, r := range []struct {
		method, path string
		body         map[string]any
	}{
		{http.MethodPatch, "/shares/" + sh.id(), map[string]any{"clear_expiry": true}},
		{http.MethodPatch, "/shares/" + sh.id(), map[string]any{"expires_at": later}},
		{http.MethodPut, "/shares/" + sh.id() + "/grants/user/" + carol.userID, map[string]any{"permission": "editor"}},
		{http.MethodDelete, "/shares/" + sh.id() + "/grants/user/" + carol.userID, nil},
	} {
		resp := bob.json(r.method, r.path, r.body)
		expect(t, resp, http.StatusNotFound)
	}
	if _, _, _, code := bob.scopedChanges(vault, sh.id(), 0); code != http.StatusNotFound {
		t.Fatalf("expired: %d", code)
	}
	// The owner brings it back; the manager manages it again.
	expect(t, ada.json(http.MethodPatch, "/shares/"+sh.id(), map[string]any{"clear_expiry": true}), http.StatusOK)
	expect(t, bob.json(http.MethodPatch, "/shares/"+sh.id(), map[string]any{"display_name": "Back"}), http.StatusOK)
}

// ADR-0041 §9: the manager role inside a group is stored and shown, and grants nothing.
func TestGroupManagerRoleGrantsNothing(t *testing.T) {
	e, ada, bob, carol, vault, _, group := sharedFixture(t)
	eve := e.user("eve")
	if err := e.app.Groups.SetMember(context.Background(), ada.uid(), group, bob.uid(), "manager"); err != nil {
		t.Fatal(err)
	}
	beta := ada.share(vault, "folder", "Projects/Beta", grantTo("group", group.String(), "viewer"))
	carol.accept(beta.id())

	// Shown: the user's own groups carry the role.
	var role any
	for _, g := range decode[[]map[string]any](t, bob.json(http.MethodGet, "/me/groups", nil)) {
		if g["id"] == group.String() {
			role = g["member_role"]
		}
	}
	if role != "manager" {
		t.Fatalf("member_role %v", role)
	}
	// No share management, no share creation, no group administration, no write.
	expect(t, bob.json(http.MethodPut, "/shares/"+beta.id()+"/grants/user/"+eve.userID, map[string]any{"permission": "viewer"}), http.StatusForbidden)
	expect(t, bob.json(http.MethodPatch, "/shares/"+beta.id(), map[string]any{"display_name": "x"}), http.StatusForbidden)
	expect(t, bob.createShare(map[string]any{"vault_id": vault, "resource_type": "folder", "path_prefix": "Projects/Beta"}), http.StatusNotFound)
	expect(t, bob.json(http.MethodPut, "/admin/groups/"+group.String()+"/members/"+eve.userID, map[string]any{"member_role": "member"}), http.StatusForbidden)
	expect(t, bob.json(http.MethodGet, "/admin/groups/"+group.String()+"/members", nil), http.StatusForbidden)
	data := []byte("new")
	expect(t, bob.raw(http.MethodPut, "/vaults/"+vault+"/blobs/"+hashOf(data)+"?scope=share:"+beta.id(), "application/octet-stream", data, nil), http.StatusForbidden)
}
