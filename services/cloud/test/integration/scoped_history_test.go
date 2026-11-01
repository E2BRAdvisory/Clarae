//go:build integration

package integration

import (
	"context"
	"fmt"
	"net/http"
	"testing"
)

type revisionPage struct {
	Items      []map[string]any `json:"items"`
	NextCursor string           `json:"next_cursor"`
}

func (c *client) revisions(vault, file, query string) revisionPage {
	c.e.t.Helper()
	resp := c.json(http.MethodGet, "/vaults/"+vault+"/files/"+file+"/revisions"+query, nil)
	expect(c.e.t, resp, http.StatusOK)
	return decode[revisionPage](c.e.t, resp)
}

// scoped-history-path-leak: through a share, history shows what the share
// showed: paths relative to its root, a move into the share as a create
// without its origin, nothing from before the file entered the share (list,
// content, restore), nothing from when it was outside.
func TestScopedHistoryHidesPathsAndPreShareRevisions(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("Company", "shared")
	ids := ada.seed(v, map[string]string{"Projects/Acme/plan.md": "plan", "HR/Confidential/salaries.md": "secret v1"})
	f := ids["HR/Confidential/salaries.md"]
	mustAccepted(t, ada.commit(v, modify(f, 1, ada.putBlob(v, []byte("secret v2"))))[0]) // rev 2, outside
	mustAccepted(t, ada.commit(v, move(f, 2, "Projects/Acme/salaries.md"))[0])           // rev 3, enters
	mustAccepted(t, ada.commit(v, modify(f, 3, ada.putBlob(v, []byte("public v4"))))[0]) // rev 4, inside
	mustAccepted(t, ada.commit(v, move(f, 4, "Projects/Acme/sub/salaries.md"))[0])       // rev 5, inside
	sh := ada.share(v, "folder", "Projects/Acme", grantTo("user", bob.userID, "editor"))
	bob.accept(sh.id())
	scope := "?scope=share:" + sh.id()

	// The owner sees everything, with vault paths.
	if all := ada.revisions(v, f, ""); len(all.Items) != 5 || all.Items[2]["prev_path"] != "HR/Confidential/salaries.md" {
		t.Fatalf("owner history: %v", all.Items)
	}

	got := bob.revisions(v, f, scope)
	want := []string{"5 move sub/salaries.md <- salaries.md", "4 modify salaries.md", "3 create salaries.md"}
	if len(got.Items) != len(want) {
		t.Fatalf("recipient history: %v", got.Items)
	}
	for i, it := range got.Items {
		line := fmt.Sprintf("%v %v %v", it["rev"], it["op"], it["path"])
		if p, ok := it["prev_path"].(string); ok {
			line += " <- " + p
		}
		if line != want[i] {
			t.Errorf("revision %d: %q, want %q", i, line, want[i])
		}
	}
	// Paged through the share: the cursor walks the visible revisions only.
	p1 := bob.revisions(v, f, scope+"&limit=2")
	if len(p1.Items) != 2 || p1.NextCursor == "" {
		t.Fatalf("page 1: %+v", p1)
	}
	if p2 := bob.revisions(v, f, scope+"&limit=2&cursor="+p1.NextCursor); len(p2.Items) != 1 || p2.Items[0]["rev"] != float64(3) || p2.NextCursor != "" {
		t.Fatalf("page 2: %+v", p2)
	}

	// The content from before the share is not readable, the later one is.
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions/1/content"+scope, nil), http.StatusNotFound)
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions/2/content"+scope, nil), http.StatusNotFound)
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions/4/content"+scope, nil), http.StatusOK)
	// Nor can it be restored into the share (that would read it).
	r := decode[result](t, bob.json(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/2:restore"+scope, nil))
	if r.status() != "rejected" || r.code() != "NOT_FOUND" {
		t.Fatalf("restore of a pre-share revision: %v", r)
	}
	r = decode[result](t, bob.json(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/4:restore"+scope, nil))
	if mustAccepted(t, r).rev() != 6 {
		t.Fatalf("restore of a shared revision: %v", r)
	}
	if top := bob.revisions(v, f, scope+"&limit=1").Items[0]; top["op"] != "restore" || top["path"] != "sub/salaries.md" {
		t.Fatalf("restored revision: %v", top)
	}

	// A file moved out of the share and back: the time outside is invisible.
	mustAccepted(t, ada.commit(v, move(f, 6, "HR/salaries.md"))[0])                   // 7: leaves
	mustAccepted(t, ada.commit(v, modify(f, 7, ada.putBlob(v, []byte("hidden"))))[0]) // 8: outside
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions"+scope, nil), http.StatusNotFound)
	mustAccepted(t, ada.commit(v, move(f, 8, "Projects/Acme/back.md"))[0]) // 9: returns
	got = bob.revisions(v, f, scope+"&limit=3")
	ops := fmt.Sprintf("%v:%v %v:%v %v:%v", got.Items[0]["rev"], got.Items[0]["op"], got.Items[1]["rev"], got.Items[1]["op"], got.Items[2]["rev"], got.Items[2]["op"])
	if ops != "9:create 7:delete 6:restore" {
		t.Fatalf("out and back: %s", ops)
	}
	if got.Items[1]["blob_hash"] != nil {
		t.Errorf("a move out of the share carries no content: %v", got.Items[1])
	}
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions/8/content"+scope, nil), http.StatusNotFound)
}

// restore-duplicates-modify: a restore goes through the commit machinery: the
// path-collision race is a rejection (not a 500), the revision is recorded as
// a restore, and a concurrent change only moves its base forward.
func TestRestoreUsesTheCommitMachinery(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("R", "shared")
	f := newID()
	mustAccepted(t, ada.commit(v, create(f, "note.md", ada.putBlob(v, []byte("one"))))[0])
	mustAccepted(t, ada.commit(v, modify(f, 1, ada.putBlob(v, []byte("two"))))[0])
	mustAccepted(t, ada.commit(v, del(f, 2))[0])
	// Another file now uses the path.
	mustAccepted(t, ada.commit(v, create(newID(), "note.md", ada.putBlob(v, []byte("other"))))[0])
	r := decode[result](t, ada.json(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/1:restore", nil))
	if r.status() != "rejected" || r.code() != "PATH_COLLISION" {
		t.Fatalf("restore onto a taken path: %v", r)
	}

	g := newID()
	mustAccepted(t, ada.commit(v, create(g, "g.md", ada.putBlob(v, []byte("g1"))))[0])
	mustAccepted(t, ada.commit(v, modify(g, 1, ada.putBlob(v, []byte("g2"))))[0])
	r = mustAccepted(t, decode[result](t, ada.json(http.MethodPost, "/vaults/"+v+"/files/"+g+"/revisions/1:restore", nil)))
	if r.rev() != 3 {
		t.Fatalf("restore: %v", r)
	}
	if top := ada.revisions(v, g, "?limit=1").Items[0]; top["op"] != "restore" {
		t.Fatalf("a restore of a live file is recorded as a restore: %v", top)
	}
	var refs int
	if err := e.db.Pool.QueryRow(context.Background(), `SELECT ref_count FROM blobs WHERE hash = $1`, hashOf([]byte("g1"))).Scan(&refs); err != nil || refs != 2 {
		t.Fatalf("ref_count of the restored blob: %d %v", refs, err)
	}
	items, _, _ := ada.changes(v, 0)
	if last := items[len(items)-1]; last["op"] != "restore" || last["rev"] != float64(3) {
		t.Fatalf("changelog: %v", last)
	}
}
