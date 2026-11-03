//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/notify"
	"memobrain/services/cloud/internal/vaults"
)

// ---- helpers ----

func (c *client) uid() uuid.UUID { return uuid.MustParse(c.userID) }

// group creates a group as the first member (any existing user stands in for the admin of M5).
func (e *env) group(name string, members ...*client) uuid.UUID {
	e.t.Helper()
	ctx := context.Background()
	admin := members[0].uid()
	g, err := e.app.Groups.Create(ctx, admin, name+"-"+uuid.NewString()[:6], "")
	if err != nil {
		e.t.Fatal(err)
	}
	for _, m := range members {
		if err := e.app.Groups.SetMember(ctx, admin, g.ID, m.uid(), "member"); err != nil {
			e.t.Fatal(err)
		}
	}
	return g.ID
}

type shareView map[string]any

func (s shareView) id() string { return s["id"].(string) }

func (c *client) share(vault, resourceType, prefix string, grants ...map[string]any) shareView {
	c.e.t.Helper()
	body := map[string]any{"vault_id": vault, "resource_type": resourceType, "display_name": "Shared " + prefix, "grants": grants}
	if prefix != "" {
		body["path_prefix"] = prefix
	}
	resp := c.json(http.MethodPost, "/shares", body)
	expect(c.e.t, resp, http.StatusCreated)
	return decode[shareView](c.e.t, resp)
}

func grantTo(ptype, id, perm string) map[string]any {
	return map[string]any{"principal_type": ptype, "principal_id": id, "permission": perm}
}

func (c *client) accept(share string) {
	c.e.t.Helper()
	expect(c.e.t, c.json(http.MethodPost, "/shares/"+share+":accept", nil), http.StatusOK)
}

// scoped changes through a share.
func (c *client) scopedChanges(vault, share string, since int64) ([]map[string]any, int64, bool, int) {
	c.e.t.Helper()
	resp := c.json(http.MethodGet, fmt.Sprintf("/vaults/%s/changes?since=%d&scope=share:%s", vault, since, share), nil)
	if resp.StatusCode != http.StatusOK {
		return nil, 0, false, resp.StatusCode
	}
	out := decode[struct {
		Items   []map[string]any `json:"items"`
		NextSeq float64          `json:"next_seq"`
		HasMore bool             `json:"has_more"`
	}](c.e.t, resp)
	return out.Items, int64(out.NextSeq), out.HasMore, http.StatusOK
}

func (c *client) scopedCommit(vault, share string, ops ...map[string]any) ([]result, int) {
	c.e.t.Helper()
	resp := c.json(http.MethodPost, fmt.Sprintf("/vaults/%s/commit?scope=share:%s", vault, share), map[string]any{"device_id": c.deviceID, "ops": ops})
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode
	}
	out := decode[struct {
		Results []result `json:"results"`
	}](c.e.t, resp)
	return out.Results, http.StatusOK
}

func pathsOf(items []map[string]any) []string {
	var out []string
	for _, it := range items {
		out = append(out, fmt.Sprintf("%s:%s", it["op"], it["path"]))
	}
	sort.Strings(out)
	return out
}

// seed creates files in a vault as its owner and returns file ids by path.
func (c *client) seed(vault string, files map[string]string) map[string]string {
	c.e.t.Helper()
	ids := map[string]string{}
	var ops []map[string]any
	for p, content := range files {
		id := newID()
		ids[p] = id
		ops = append(ops, create(id, p, c.putBlob(vault, []byte(content))))
	}
	for _, r := range c.commit(vault, ops...) {
		mustAccepted(c.e.t, r)
	}
	return ids
}

func sharedFixture(t *testing.T) (e *env, ada, bob, carol *client, vault string, ids map[string]string, group uuid.UUID) {
	e = newEnv(t)
	ada, bob, carol = e.user("ada"), e.user("bob"), e.user("carol")
	vault = ada.createVault("Company", "shared")
	ids = ada.seed(vault, map[string]string{
		"Projects/Alfa/plan.md":  "# plan",
		"Projects/Alfa/sub/a.md": "alpha a",
		"Projects/Beta/x.md":     "beta x",
		"root.md":                "root",
	})
	group = e.group("team", bob, carol)
	return
}

// ---- tests ----

func TestOnlySharedVaultsCanBeShared(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	private := ada.createPrivateVault("Diary")
	resp := ada.json(http.MethodPost, "/shares", map[string]any{"vault_id": private, "resource_type": "vault", "display_name": "x"})
	expect(t, resp, http.StatusConflict)
	if p := decode[map[string]any](t, resp); p["code"] != "VAULT_ENCRYPTED" {
		t.Fatalf("code %v", p["code"])
	}
	shared := ada.createVault("Notes", "shared")
	// Somebody else's vault is invisible; an unknown folder is not shareable.
	expect(t, bob.json(http.MethodPost, "/shares", map[string]any{"vault_id": shared, "resource_type": "vault", "display_name": "x"}), http.StatusNotFound)
	expect(t, ada.json(http.MethodPost, "/shares", map[string]any{"vault_id": shared, "resource_type": "folder", "path_prefix": "Nothing", "display_name": "x"}), http.StatusNotFound)
	expect(t, ada.json(http.MethodPost, "/shares", map[string]any{"vault_id": shared, "resource_type": "folder", "path_prefix": "../x", "display_name": "x"}), http.StatusBadRequest)
}

func TestGroupFolderShareEndToEnd(t *testing.T) {
	e, ada, bob, carol, vault, ids, group := sharedFixture(t)
	dave := e.user("dave")
	sh := ada.share(vault, "folder", "Projects/Alfa", grantTo("group", group.String(), "editor"), grantTo("user", dave.userID, "viewer"))

	// Invited but not accepted: nothing is reachable yet.
	if _, _, _, code := bob.scopedChanges(vault, sh.id(), 0); code != http.StatusNotFound {
		t.Fatalf("before accepting: %d", code)
	}
	received := pageItems[shareView](t, bob.json(http.MethodGet, "/shares?scope=received", nil))
	if len(received) != 1 || received[0]["my_status"] != "pending" || received[0]["my_permission"] != "editor" {
		t.Fatalf("invitation: %v", received)
	}
	if received[0]["grants"] != nil || received[0]["path_prefix"] != nil {
		t.Fatalf("a recipient must not see grants or the folder path: %v", received[0])
	}
	if mounts := pageItems[map[string]any](t, bob.json(http.MethodGet, "/shared-with-me", nil)); len(mounts) != 0 {
		t.Fatalf("a pending invitation is not a mount: %v", mounts)
	}

	bob.accept(sh.id())
	mounts := pageItems[map[string]any](t, bob.json(http.MethodGet, "/shared-with-me", nil))
	if len(mounts) != 1 || mounts[0]["scope"] != "share:"+sh.id() || mounts[0]["permission"] != "editor" || mounts[0]["vault_id"] != vault {
		t.Fatalf("mounts: %v", mounts)
	}
	// One member accepted for the group: carol sees it as a mount too (§: a group grant is accepted once).
	if m := pageItems[map[string]any](t, carol.json(http.MethodGet, "/shared-with-me", nil)); len(m) != 1 {
		t.Fatalf("group mate: %v", m)
	}

	// Pull: only the shared subtree, paths relative to its root.
	items, next, more, code := bob.scopedChanges(vault, sh.id(), 0)
	if code != http.StatusOK || more {
		t.Fatalf("changes: %d %v", code, more)
	}
	if got := strings.Join(pathsOf(items), ","); got != "create:plan.md,create:sub/a.md" {
		t.Fatalf("scoped changes: %s", got)
	}
	_, ownerNext, _ := ada.changes(vault, 0)
	if next != ownerNext {
		t.Fatalf("the cursor must reach the head of the vault, %d vs %d", next, ownerNext)
	}
	resp := bob.json(http.MethodGet, "/vaults/"+vault+"/tree?scope=share:"+sh.id(), nil)
	expect(t, resp, http.StatusOK)
	tree := decode[struct{ Items []map[string]any }](t, resp)
	var treePaths []string
	for _, it := range tree.Items {
		treePaths = append(treePaths, it["path"].(string))
	}
	sort.Strings(treePaths)
	if strings.Join(treePaths, ",") != "plan.md,sub/a.md" {
		t.Fatalf("scoped tree: %v", treePaths)
	}

	// Blobs: readable inside the share, not outside it.
	planHash := hashOf([]byte("# plan"))
	expect(t, bob.json(http.MethodGet, "/vaults/"+vault+"/blobs/"+planHash+"?scope=share:"+sh.id(), nil), http.StatusOK)
	expect(t, bob.json(http.MethodGet, "/vaults/"+vault+"/blobs/"+hashOf([]byte("beta x"))+"?scope=share:"+sh.id(), nil), http.StatusNotFound)
	expect(t, bob.json(http.MethodGet, "/vaults/"+vault+"/blobs/"+planHash, nil), http.StatusNotFound) // no scope: not his vault

	// Edit inside the share: ada receives it, authored by bob.
	newHash := bob.scopedPut(t, vault, sh.id(), []byte("# plan v2"))
	res, code := bob.scopedCommit(vault, sh.id(), modify(ids["Projects/Alfa/plan.md"], 1, newHash))
	if code != http.StatusOK || res[0].status() != "accepted" || res[0].rev() != 2 {
		t.Fatalf("editor commit: %d %v", code, res)
	}
	adaItems, _, _ := ada.changes(vault, ownerNext)
	if len(adaItems) != 1 || adaItems[0]["path"] != "Projects/Alfa/plan.md" || adaItems[0]["author_id"] != bob.userID {
		t.Fatalf("owner sees: %v", adaItems)
	}
	// A new file in the share lands under its prefix in the vault.
	newFile := newID()
	res, _ = bob.scopedCommit(vault, sh.id(), create(newFile, "notes/new.md", bob.scopedPut(t, vault, sh.id(), []byte("new"))))
	mustAccepted(t, res[0])
	if tree, _ := ada.tree(vault); tree["Projects/Alfa/notes/new.md"] == nil {
		t.Fatalf("owner tree: %v", tree)
	}

	// Confinement: no way out of the share, and the outside does not exist for the editor.
	for _, bad := range []string{"../Beta/y.md", "/abs.md", "a/../../Beta/y.md", ""} {
		res, _ := bob.scopedCommit(vault, sh.id(), create(newID(), bad, newHash))
		if res[0].status() != "rejected" || res[0].code() != "PATH_INVALID" {
			t.Errorf("path %q: %v", bad, res[0])
		}
	}
	res, _ = bob.scopedCommit(vault, sh.id(), modify(ids["Projects/Beta/x.md"], 1, newHash))
	if res[0].status() != "rejected" || res[0].code() != "NOT_FOUND" {
		t.Errorf("a file outside the share: %v", res[0])
	}
	res, _ = bob.scopedCommit(vault, sh.id(), move(ids["Projects/Alfa/plan.md"], 2, "../Beta/plan.md"))
	if res[0].status() != "rejected" || res[0].code() != "PATH_INVALID" {
		t.Errorf("moving out: %v", res[0])
	}
	// The root of a mount cannot be renamed from the mount.
	res, _ = bob.scopedCommit(vault, sh.id(), map[string]any{"op_id": newID(), "op": "move_prefix", "from": "", "to": "Other"})
	if res[0].code() != "SHARE_ROOT_MOVE" {
		t.Errorf("root move: %v", res[0])
	}
	// A rename inside the share is fine.
	res, _ = bob.scopedCommit(vault, sh.id(), map[string]any{"op_id": newID(), "op": "move_prefix", "from": "sub", "to": "docs"})
	mustAccepted(t, res[0])
	if tree, _ := ada.tree(vault); tree["Projects/Alfa/docs/a.md"] == nil {
		t.Fatalf("rename inside: %v", tree)
	}

	// History through the share; a file outside it is unknown.
	expect(t, bob.json(http.MethodGet, fmt.Sprintf("/vaults/%s/files/%s/revisions?scope=share:%s", vault, ids["Projects/Alfa/plan.md"], sh.id()), nil), http.StatusOK)
	expect(t, bob.json(http.MethodGet, fmt.Sprintf("/vaults/%s/files/%s/revisions?scope=share:%s", vault, ids["Projects/Beta/x.md"], sh.id()), nil), http.StatusNotFound)
	resp = bob.json(http.MethodPost, fmt.Sprintf("/vaults/%s/files/%s/revisions/1:restore?scope=share:%s", vault, ids["Projects/Alfa/plan.md"], sh.id()), nil)
	expect(t, resp, http.StatusOK)

	// Dave is a viewer: he reads, he cannot write.
	dave.accept(sh.id())
	if items, _, _, code := dave.scopedChanges(vault, sh.id(), 0); code != http.StatusOK || len(items) == 0 {
		t.Fatalf("viewer pull: %d", code)
	}
	if _, code := dave.scopedCommit(vault, sh.id(), create(newID(), "x.md", newHash)); code != http.StatusForbidden {
		t.Errorf("a viewer's commit: %d", code)
	}
	expect(t, dave.raw(http.MethodPut, "/vaults/"+vault+"/blobs/"+hashOf([]byte("zzz"))+"?scope=share:"+sh.id(), "application/octet-stream", []byte("zzz"), nil), http.StatusForbidden)
	expect(t, dave.json(http.MethodPost, fmt.Sprintf("/vaults/%s/files/%s/revisions/1:restore?scope=share:%s", vault, ids["Projects/Alfa/plan.md"], sh.id()), nil), http.StatusForbidden)

	// Revocation: the recipients lose it at once.
	expect(t, ada.json(http.MethodDelete, "/shares/"+sh.id(), nil), http.StatusNoContent)
	for _, u := range []*client{bob, carol, dave} {
		if _, _, _, code := u.scopedChanges(vault, sh.id(), 0); code != http.StatusNotFound {
			t.Errorf("%s after revocation: %d", u.userID, code)
		}
		if m := pageItems[map[string]any](t, u.json(http.MethodGet, "/shared-with-me", nil)); len(m) != 0 {
			t.Errorf("mounts after revocation: %v", m)
		}
	}
}

// scopedPut uploads a blob through a share.
func (c *client) scopedPut(t *testing.T, vault, share string, data []byte) string {
	t.Helper()
	h := hashOf(data)
	expect(t, c.raw(http.MethodPut, "/vaults/"+vault+"/blobs/"+h+"?scope=share:"+share, "application/octet-stream", data, nil), http.StatusNoContent)
	return h
}

func TestFilesLeavingAndEnteringAShareAreDeletesAndCreates(t *testing.T) {
	_, ada, bob, _, vault, ids, _ := sharedFixture(t)
	sh := ada.share(vault, "folder", "Projects/Alfa", grantTo("user", bob.userID, "viewer"))
	bob.accept(sh.id())
	_, cursor, _, _ := bob.scopedChanges(vault, sh.id(), 0)

	mustAccepted(t, ada.commit(vault, move(ids["Projects/Alfa/plan.md"], 1, "Projects/Beta/plan.md"))[0])
	mustAccepted(t, ada.commit(vault, move(ids["Projects/Beta/x.md"], 1, "Projects/Alfa/x.md"))[0])
	mustAccepted(t, ada.commit(vault, modify(ids["root.md"], 1, ada.putBlob(vault, []byte("changed root"))))[0])

	items, _, _, _ := bob.scopedChanges(vault, sh.id(), cursor)
	if got := strings.Join(pathsOf(items), ","); got != "create:x.md,delete:plan.md" {
		t.Fatalf("got %s", got)
	}
	for _, it := range items {
		if it["op"] == "delete" && it["blob_hash"] != nil {
			t.Error("a delete carries no blob")
		}
		if it["op"] == "create" && it["blob_hash"] == nil {
			t.Error("an entering file carries its blob")
		}
	}
}

func TestShareRootProtection(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	vault := ada.createVault("V", "shared")
	ids := ada.seed(vault, map[string]string{"Docs/Only/a.md": "a", "Docs/Only/b.md": "b", "Other/o.md": "o"})
	sh := ada.share(vault, "folder", "Docs/Only", grantTo("user", bob.userID, "editor"))
	bob.accept(sh.id())

	// Moving files out one by one is fine until the last one: then the whole share would vanish.
	mustAccepted(t, ada.commit(vault, move(ids["Docs/Only/a.md"], 1, "Other/a.md"))[0])
	res := ada.commit(vault, move(ids["Docs/Only/b.md"], 1, "Other/b.md"))
	if res[0].status() != "rejected" || res[0].code() != "SHARE_ROOT_MOVE" {
		t.Fatalf("last file out: %v", res[0])
	}

	// Renaming the folder carries the share along: the recipient keeps syncing.
	mustAccepted(t, ada.commit(vault, map[string]any{"op_id": newID(), "op": "move_prefix", "from": "Docs", "to": "Archive"})[0])
	got := decode[shareView](t, ada.json(http.MethodGet, "/shares/"+sh.id(), nil))
	if got["path_prefix"] != "Archive/Only" {
		t.Fatalf("share prefix: %v", got["path_prefix"])
	}
	resp := bob.json(http.MethodGet, "/vaults/"+vault+"/tree?scope=share:"+sh.id(), nil)
	expect(t, resp, http.StatusOK)
	if items := decode[struct{ Items []map[string]any }](t, resp).Items; len(items) != 1 || items[0]["path"] != "b.md" {
		t.Fatalf("tree after the rename: %v", items)
	}
}

// TestMovePrefixShareRoots: a folder rename (move_prefix) follows the share-root rules of the
// file-by-file moves (§3.4.7, ADR-0040). A folder inside a share that takes every file of the
// share elsewhere is refused with SHARE_ROOT_MOVE (it would empty the share without rebasing it);
// one that leaves something behind, or stays inside, is an ordinary rename.
func TestMovePrefixShareRoots(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	vault := ada.createVault("V", "shared")
	ada.seed(vault, map[string]string{
		"Docs/Only/Sub/a.md": "a", "Docs/Only/Sub/Deep/b.md": "b",
		"Docs/Part/Sub/x.md": "x", "Docs/Part/keep.md": "k",
	})
	only := ada.share(vault, "folder", "Docs/Only", grantTo("user", bob.userID, "editor"))
	part := ada.share(vault, "folder", "Docs/Part", grantTo("user", bob.userID, "editor"))
	bob.accept(only.id())
	bob.accept(part.id())
	prefixOf := func(sh shareView) any {
		return decode[shareView](t, ada.json(http.MethodGet, "/shares/"+sh.id(), nil))["path_prefix"]
	}
	movePrefix := func(from, to string) map[string]any {
		return map[string]any{"op_id": newID(), "op": "move_prefix", "from": from, "to": to}
	}

	// Every file of Docs/Only lives under Docs/Only/Sub: moving it out would empty the share.
	res := ada.commit(vault, movePrefix("Docs/Only/Sub", "Archive/Sub"))
	if res[0].status() != "rejected" || res[0].code() != "SHARE_ROOT_MOVE" {
		t.Fatalf("folder taking the whole share out: %v", res[0])
	}
	if paths, _ := ada.tree(vault); paths["Docs/Only/Sub/a.md"] == nil || paths["Archive/Sub/a.md"] != nil {
		t.Fatalf("a refused move_prefix must not touch the files: %v", paths)
	}
	if got := prefixOf(only); got != "Docs/Only" {
		t.Fatalf("share prefix after the refusal: %v", got)
	}

	// Inside the share, the same folder can be renamed.
	mustAccepted(t, ada.commit(vault, movePrefix("Docs/Only/Sub", "Docs/Only/Renamed"))[0])
	resp := bob.json(http.MethodGet, "/vaults/"+vault+"/tree?scope=share:"+only.id(), nil)
	expect(t, resp, http.StatusOK)
	if items := decode[struct{ Items []map[string]any }](t, resp).Items; len(items) != 2 {
		t.Fatalf("mount after a rename inside the share: %v", items)
	}

	// Docs/Part keeps keep.md: moving its sub-folder out is a plain move (the mount sees deletions).
	mustAccepted(t, ada.commit(vault, movePrefix("Docs/Part/Sub", "Archive/PartSub"))[0])
	if got := prefixOf(part); got != "Docs/Part" {
		t.Fatalf("a share left with files keeps its prefix: %v", got)
	}

	// Renaming the share's root folder still carries the share along.
	mustAccepted(t, ada.commit(vault, movePrefix("Docs/Only", "Shared/Only"))[0])
	if got := prefixOf(only); got != "Shared/Only" {
		t.Fatalf("share prefix after renaming its root: %v", got)
	}
}

// TestMovePrefixFromMountRebasesNestedShares: an editor renaming a folder through a mount carries
// the shares nested inside it along, and cannot take every file of a nested share out of it.
func TestMovePrefixFromMountRebasesNestedShares(t *testing.T) {
	e := newEnv(t)
	ada, bob, carol := e.user("ada"), e.user("bob"), e.user("carol")
	vault := ada.createVault("V", "shared")
	ids := ada.seed(vault, map[string]string{
		"Projects/Acme/Inner/r.md": "r", "Projects/Acme/Inner/s.md": "s", "Projects/readme.md": "p",
	})
	outer := ada.share(vault, "folder", "Projects", grantTo("user", bob.userID, "editor"))
	nested := ada.share(vault, "folder", "Projects/Acme", grantTo("user", carol.userID, "editor"))
	bob.accept(outer.id())
	carol.accept(nested.id())
	movePrefix := func(from, to string) map[string]any {
		return map[string]any{"op_id": newID(), "op": "move_prefix", "from": from, "to": to}
	}
	carolTree := func() []map[string]any {
		resp := carol.json(http.MethodGet, "/vaults/"+vault+"/tree?scope=share:"+nested.id(), nil)
		expect(t, resp, http.StatusOK)
		return decode[struct{ Items []map[string]any }](t, resp).Items
	}

	// Taking every file of carol's share out of it, as a folder or one file at a time, is refused.
	res, status := bob.scopedCommit(vault, outer.id(), movePrefix("Acme/Inner", "Elsewhere"))
	if status != http.StatusOK || res[0].status() != "rejected" || res[0].code() != "SHARE_ROOT_MOVE" {
		t.Fatalf("emptying a nested share from the mount: %d %v", status, res)
	}
	if d, _ := res[0]["detail"].(string); strings.Contains(d, "Projects/") {
		t.Errorf("the detail must use the mount's paths: %q", d)
	}
	res, _ = bob.scopedCommit(vault, outer.id(), move(ids["Projects/Acme/Inner/r.md"], 1, "r.md"))
	mustAccepted(t, res[0])
	res, _ = bob.scopedCommit(vault, outer.id(), move(ids["Projects/Acme/Inner/s.md"], 1, "s.md"))
	if res[0].status() != "rejected" || res[0].code() != "SHARE_ROOT_MOVE" {
		t.Fatalf("last file of a nested share moved out from the mount: %v", res[0])
	}

	// Renaming the nested share's root from the mount rebases it: carol keeps her file.
	res, _ = bob.scopedCommit(vault, outer.id(), movePrefix("Acme", "Acme-2024"))
	mustAccepted(t, res[0])
	got := decode[shareView](t, ada.json(http.MethodGet, "/shares/"+nested.id(), nil))
	if got["path_prefix"] != "Projects/Acme-2024" {
		t.Fatalf("nested share prefix after the rename from the mount: %v", got["path_prefix"])
	}
	if items := carolTree(); len(items) != 1 || items[0]["path"] != "Inner/s.md" {
		t.Fatalf("carol's mount after the rename: %v", items)
	}
	// bob's own share is not touched, and its root still cannot be renamed from the mount.
	if got := decode[shareView](t, ada.json(http.MethodGet, "/shares/"+outer.id(), nil)); got["path_prefix"] != "Projects" {
		t.Fatalf("the mount's own share moved: %v", got["path_prefix"])
	}
	res, _ = bob.scopedCommit(vault, outer.id(), movePrefix("", "Other"))
	if res[0].code() != "SHARE_ROOT_MOVE" {
		t.Fatalf("renaming the mount root: %v", res[0])
	}
}

func TestDocumentShare(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	vault := ada.createVault("V", "shared")
	ids := ada.seed(vault, map[string]string{"Deep/Folder/Report.md": "r1", "Deep/other.md": "o"})
	resp := ada.json(http.MethodPost, "/shares", map[string]any{
		"vault_id": vault, "resource_type": "file", "file_id": ids["Deep/Folder/Report.md"], "display_name": "Report",
		"grants": []map[string]any{grantTo("user", bob.userID, "editor")},
	})
	expect(t, resp, http.StatusCreated)
	sh := decode[shareView](t, resp)
	bob.accept(sh.id())

	items, _, _, _ := bob.scopedChanges(vault, sh.id(), 0)
	if got := strings.Join(pathsOf(items), ","); got != "create:Report.md" {
		t.Fatalf("document mount: %s", got)
	}
	// Edit it; nothing beside it can be added or moved.
	h := bob.scopedPut(t, vault, sh.id(), []byte("r2"))
	res, _ := bob.scopedCommit(vault, sh.id(), modify(ids["Deep/Folder/Report.md"], 1, h))
	mustAccepted(t, res[0])
	res, _ = bob.scopedCommit(vault, sh.id(), create(newID(), "extra.md", h))
	if res[0].code() != "FORBIDDEN" {
		t.Errorf("create beside a document: %v", res[0])
	}
	res, _ = bob.scopedCommit(vault, sh.id(), modify(ids["Deep/other.md"], 1, h))
	if res[0].code() != "NOT_FOUND" {
		t.Errorf("another file: %v", res[0])
	}
	// The owner moves the document to another folder: the mount does not notice a rename of the folder only.
	_, cursor, _, _ := bob.scopedChanges(vault, sh.id(), 0)
	mustAccepted(t, ada.commit(vault, move(ids["Deep/Folder/Report.md"], 2, "Elsewhere/Report.md"))[0])
	if items, _, _, _ := bob.scopedChanges(vault, sh.id(), cursor); len(items) != 0 {
		t.Fatalf("a folder change is invisible to a document share: %v", items)
	}
	// Deleting the shared file is a deletion in the mount.
	mustAccepted(t, ada.commit(vault, del(ids["Deep/Folder/Report.md"], 3))[0])
	if items, _, _, _ := bob.scopedChanges(vault, sh.id(), cursor); strings.Join(pathsOf(items), ",") != "delete:Report.md" {
		t.Fatalf("deletion: %v", items)
	}
}

func TestInvitationWorkflow(t *testing.T) {
	e, ada, bob, carol, vault, _, group := sharedFixture(t)
	sh := ada.share(vault, "vault", "", grantTo("user", bob.userID, "viewer"), grantTo("group", group.String(), "editor"))

	// A user grant can be declined and then gives nothing; a group grant cannot be declined by one member.
	expect(t, carol.json(http.MethodPost, "/shares/"+sh.id()+":decline", nil), http.StatusConflict)
	decl := bob.json(http.MethodPost, "/shares/"+sh.id()+":decline", nil)
	expect(t, decl, http.StatusOK)
	// bob is also in the group: he still has the editor grant through it, once accepted.
	_ = e
	expect(t, bob.json(http.MethodPost, "/shares/"+sh.id()+":accept", nil), http.StatusOK)
	got := decode[shareView](t, bob.json(http.MethodGet, "/shares/"+sh.id(), nil))
	if got["my_status"] != "accepted" || got["my_permission"] != "editor" {
		t.Fatalf("bob: %v", got)
	}
	// The strangers learn nothing.
	stranger := e.user("eve")
	expect(t, stranger.json(http.MethodGet, "/shares/"+sh.id(), nil), http.StatusNotFound)
	expect(t, stranger.json(http.MethodPost, "/shares/"+sh.id()+":accept", nil), http.StatusNotFound)
	if r := pageItems[shareView](t, stranger.json(http.MethodGet, "/shares?scope=received", nil)); len(r) != 0 {
		t.Fatalf("eve: %v", r)
	}
}

func TestShareManagementRights(t *testing.T) {
	e, ada, bob, carol, vault, _, _ := sharedFixture(t)
	eve := e.user("eve")
	sh := ada.share(vault, "vault", "", grantTo("user", bob.userID, "manager"), grantTo("user", carol.userID, "editor"))
	bob.accept(sh.id())
	carol.accept(sh.id())

	// An editor cannot manage; the manager and the owner can; only the owner revokes.
	expect(t, carol.json(http.MethodPut, "/shares/"+sh.id()+"/grants/user/"+eve.userID, map[string]any{"permission": "viewer"}), http.StatusForbidden)
	expect(t, carol.json(http.MethodPatch, "/shares/"+sh.id(), map[string]any{"display_name": "x"}), http.StatusForbidden)
	expect(t, bob.json(http.MethodPut, "/shares/"+sh.id()+"/grants/user/"+eve.userID, map[string]any{"permission": "viewer"}), http.StatusOK)
	expect(t, bob.json(http.MethodPatch, "/shares/"+sh.id(), map[string]any{"display_name": "Renamed"}), http.StatusOK)
	expect(t, bob.json(http.MethodDelete, "/shares/"+sh.id(), nil), http.StatusForbidden)
	// The manager sees the grants; the editor does not.
	if g := decode[shareView](t, bob.json(http.MethodGet, "/shares/"+sh.id(), nil))["grants"]; g == nil {
		t.Error("a manager sees the grants")
	}
	if g := decode[shareView](t, carol.json(http.MethodGet, "/shares/"+sh.id(), nil))["grants"]; g != nil {
		t.Error("an editor must not see the grants")
	}
	// Removing a grant takes the access away.
	eve.accept(sh.id())
	if _, _, _, code := eve.scopedChanges(vault, sh.id(), 0); code != http.StatusOK {
		t.Fatalf("eve before removal: %d", code)
	}
	expect(t, bob.json(http.MethodDelete, "/shares/"+sh.id()+"/grants/user/"+eve.userID, nil), http.StatusNoContent)
	if _, _, _, code := eve.scopedChanges(vault, sh.id(), 0); code != http.StatusNotFound {
		t.Fatalf("eve after removal: %d", code)
	}
	// The owner cannot be granted to; unknown principals are refused.
	expect(t, ada.json(http.MethodPut, "/shares/"+sh.id()+"/grants/user/"+ada.userID, map[string]any{"permission": "viewer"}), http.StatusBadRequest)
	expect(t, ada.json(http.MethodPut, "/shares/"+sh.id()+"/grants/user/"+uuid.NewString(), map[string]any{"permission": "viewer"}), http.StatusNotFound)
	// The share lists: the owner and the manager see it as theirs.
	for _, u := range []*client{ada, bob} {
		if l := pageItems[shareView](t, u.json(http.MethodGet, "/shares?scope=owned", nil)); len(l) != 1 {
			t.Errorf("owned list: %v", l)
		}
	}
	// Expiry.
	soon := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	expect(t, ada.json(http.MethodPatch, "/shares/"+sh.id(), map[string]any{"expires_at": soon}), http.StatusOK)
	expect(t, ada.json(http.MethodPatch, "/shares/"+sh.id(), map[string]any{"clear_expiry": true}), http.StatusOK)
	expect(t, ada.json(http.MethodPatch, "/shares/"+sh.id(), map[string]any{"expires_at": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)}), http.StatusBadRequest)
}

func TestExpiredShareGivesNothing(t *testing.T) {
	_, ada, bob, _, vault, _, _ := sharedFixture(t)
	sh := ada.share(vault, "vault", "", grantTo("user", bob.userID, "viewer"))
	bob.accept(sh.id())
	if _, _, _, code := bob.scopedChanges(vault, sh.id(), 0); code != http.StatusOK {
		t.Fatalf("before expiry: %d", code)
	}
	if _, err := ada.e.db.Pool.Exec(context.Background(), "UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1", sh.id()); err != nil {
		t.Fatal(err)
	}
	if _, _, _, code := bob.scopedChanges(vault, sh.id(), 0); code != http.StatusNotFound {
		t.Fatalf("after expiry: %d", code)
	}
	if m := pageItems[map[string]any](t, bob.json(http.MethodGet, "/shared-with-me", nil)); len(m) != 0 {
		t.Fatalf("mounts: %v", m)
	}
}

func TestEffectivePermissionMatrix(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	ada, bob, carol := e.user("ada"), e.user("bob"), e.user("carol")
	vault := ada.createVault("V", "shared")
	ids := ada.seed(vault, map[string]string{"A/one.md": "1", "A/B/two.md": "2", "C/three.md": "3"})
	team := e.group("team", bob)

	folder := ada.share(vault, "folder", "A", grantTo("group", team.String(), "viewer"), grantTo("user", bob.userID, "editor"))
	fileShare := decode[shareView](t, ada.json(http.MethodPost, "/shares", map[string]any{
		"vault_id": vault, "resource_type": "file", "file_id": ids["C/three.md"], "display_name": "three",
		"grants": []map[string]any{grantTo("user", carol.userID, "manager")},
	}))
	v, err := e.app.Vaults.Open(ctx, ada.uid(), uuid.MustParse(vault))
	if err != nil {
		t.Fatal(err)
	}
	eff := func(c *client, path string) access.Permission {
		t.Helper()
		p, err := e.app.Sharing.Evaluator(c.uid()).Effective(ctx, v, path)
		if err != nil {
			t.Fatal(err)
		}
		return p
	}
	// Pending grants count for nothing.
	if eff(bob, "A/one.md") != access.None || eff(carol, "C/three.md") != access.None {
		t.Fatal("pending grants must not give access")
	}
	bob.accept(folder.id())
	carol.accept(fileShare.id())
	for _, c := range []struct {
		who  *client
		path string
		want access.Permission
	}{
		{ada, "A/one.md", access.Owner}, {ada, "anything.md", access.Owner},
		{bob, "A/one.md", access.Editor},   // maximum of viewer (group) and editor (user)
		{bob, "A/B/two.md", access.Editor}, // the folder covers its descendants
		{bob, "C/three.md", access.None},
		{bob, "A", access.None}, // the folder itself is not a file
		{carol, "C/three.md", access.Manager},
		{carol, "A/one.md", access.None},
	} {
		if got := eff(c.who, c.path); got != c.want {
			t.Errorf("%s on %s = %s, want %s", c.who.userID[:8], c.path, got, c.want)
		}
	}
	// A private vault admits only its owner, whatever rows exist.
	priv := vaults.Vault{ID: uuid.New(), OwnerID: ada.uid(), Kind: "private"}
	if p, _ := e.app.Sharing.Evaluator(bob.uid()).Effective(ctx, priv, "x"); p != access.None {
		t.Errorf("private vault: %s", p)
	}
	if p, _ := e.app.Sharing.Evaluator(ada.uid()).Effective(ctx, priv, "x"); p != access.Owner {
		t.Errorf("private vault owner: %s", p)
	}
	// Revoked shares stop counting.
	expect(t, ada.json(http.MethodDelete, "/shares/"+folder.id(), nil), http.StatusNoContent)
	if got := e.app.Sharing.Evaluator(bob.uid()); got == nil {
		t.Fatal("evaluator")
	}
	if p, _ := e.app.Sharing.Evaluator(bob.uid()).Effective(ctx, v, "A/one.md"); p != access.None {
		t.Errorf("after revocation: %s", p)
	}
}

func TestSharingEvents(t *testing.T) {
	e, ada, bob, _, vault, ids, group := sharedFixture(t)
	sub := e.app.Hub.Subscribe(bob.uid())
	defer e.app.Hub.Unsubscribe(sub)
	next := func() []notify.Event {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for {
			evs, err := sub.Next(ctx)
			if err != nil {
				t.Fatalf("no event: %v", err)
			}
			// Configuration revisions (group changes bump one) are somebody else's business here.
			var kept []notify.Event
			for _, ev := range evs {
				if ev.Kind != notify.KindConfig {
					kept = append(kept, ev)
				}
			}
			if len(kept) > 0 {
				return kept
			}
		}
	}

	sh := ada.share(vault, "folder", "Projects/Alfa", grantTo("group", group.String(), "editor"))
	evs := next()
	if len(evs) != 1 || evs[0].Kind != notify.KindShare || evs[0].ShareID.String() != sh.id() || evs[0].ShareKind != "granted" {
		t.Fatalf("invitation event: %+v", evs)
	}
	bob.accept(sh.id())
	next() // his own acceptance

	// Changes of the owner reach the recipient as vault events.
	mustAccepted(t, ada.commit(vault, modify(ids["Projects/Alfa/plan.md"], 1, ada.putBlob(vault, []byte("v2"))))[0])
	var gotVault bool
	for deadline := time.Now().Add(5 * time.Second); !gotVault && time.Now().Before(deadline); {
		for _, ev := range next() {
			gotVault = gotVault || (ev.Kind == notify.KindVault && ev.VaultID.String() == vault)
		}
	}
	if !gotVault {
		t.Fatal("the recipient did not hear about the vault change")
	}

	// Revocation reaches whoever had the share.
	expect(t, ada.json(http.MethodDelete, "/shares/"+sh.id(), nil), http.StatusNoContent)
	evs = next()
	if len(evs) != 1 || evs[0].ShareKind != "revoked" {
		t.Fatalf("revocation event: %+v", evs)
	}
	// ...and a vault change after it no longer does.
	mustAccepted(t, ada.commit(vault, modify(ids["Projects/Alfa/plan.md"], 2, ada.putBlob(vault, []byte("v3"))))[0])
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	if evs, err := sub.Next(ctx); err == nil {
		t.Fatalf("an ex-recipient got %+v", evs)
	}
}

func TestDirectoryAndMyGroups(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("adalovelace"), e.user("bobsmith")
	g := e.group("engineers", bob)
	var found []map[string]any
	found = decode[[]map[string]any](t, ada.json(http.MethodGet, "/directory/users?q=bobsm", nil))
	if len(found) != 1 || found[0]["username"] != "bobsmith" || found[0]["email"] != nil {
		t.Fatalf("users: %v", found)
	}
	groups := decode[[]map[string]any](t, ada.json(http.MethodGet, "/directory/groups?q=engin", nil))
	if len(groups) != 1 || groups[0]["id"] != g.String() {
		t.Fatalf("groups: %v", groups)
	}
	mine := decode[[]map[string]any](t, bob.json(http.MethodGet, "/me/groups", nil))
	if len(mine) != 1 || mine[0]["member_role"] != "member" {
		t.Fatalf("memberships: %v", mine)
	}
	if mine := decode[[]map[string]any](t, ada.json(http.MethodGet, "/me/groups", nil)); len(mine) != 0 {
		t.Fatalf("ada: %v", mine)
	}
}
