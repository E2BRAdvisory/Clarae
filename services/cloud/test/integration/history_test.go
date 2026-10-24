//go:build integration

package integration

import (
	"fmt"
	"io"
	"net/http"
	"testing"
)

func TestRevisionHistoryAndRestore(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("History", "shared")
	f := newID()
	u := newID() // blobs are global: keep them unique per run so reference counts start at zero
	contents := []string{"first" + u, "second!" + u, "third!!" + u}
	hashes := make([]string, len(contents))
	for i, c := range contents {
		hashes[i] = ada.putBlob(v, []byte(c))
	}
	mustAccepted(t, ada.commit(v, create(f, "doc.md", hashes[0]))[0])
	mustAccepted(t, ada.commit(v, modify(f, 1, hashes[1]))[0])
	mustAccepted(t, ada.commit(v, modify(f, 2, hashes[2]))[0])

	resp := ada.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions", nil)
	expect(t, resp, http.StatusOK)
	list := decode[struct {
		Items []map[string]any `json:"items"`
	}](t, resp)
	if len(list.Items) != 3 || list.Items[0]["rev"].(float64) != 3 || list.Items[2]["rev"].(float64) != 1 {
		t.Fatalf("history order: %v", list.Items)
	}
	// Pagination by cursor.
	resp = ada.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions?limit=2", nil)
	page := decode[struct {
		Items      []map[string]any `json:"items"`
		NextCursor string           `json:"next_cursor"`
	}](t, resp)
	if len(page.Items) != 2 || page.NextCursor != "2" {
		t.Fatalf("page 1: %+v", page)
	}
	resp = ada.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions?limit=2&cursor="+page.NextCursor, nil)
	page = decode[struct {
		Items      []map[string]any `json:"items"`
		NextCursor string           `json:"next_cursor"`
	}](t, resp)
	if len(page.Items) != 1 || page.NextCursor != "" || page.Items[0]["rev"].(float64) != 1 {
		t.Fatalf("page 2: %+v", page)
	}

	// Content of an old revision.
	resp = ada.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions/1/content", nil)
	expect(t, resp, http.StatusOK)
	if b, _ := io.ReadAll(resp.Body); string(b) != "first"+u {
		t.Fatalf("content: %q", b)
	}
	expect(t, ada.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions/9/content", nil), http.StatusNotFound)
	expect(t, bob.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions", nil), http.StatusNotFound)

	// Restore revision 1: a new revision 4 that reuses the old blob.
	resp = ada.json(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/1:restore", nil)
	expect(t, resp, http.StatusOK)
	r := decode[result](t, resp)
	if r.status() != "accepted" || r.rev() != 4 {
		t.Fatalf("restore: %v", r)
	}
	tree, _ := ada.tree(v)
	if tree["doc.md"]["hash"] != hashes[0] || tree["doc.md"]["rev"].(float64) != 4 {
		t.Fatalf("tree after restore: %v", tree)
	}
	var refs int
	if err := e.db.Pool.QueryRow(ctxBg(), `SELECT ref_count FROM blobs WHERE hash=$1`, hashes[0]).Scan(&refs); err != nil || refs != 2 {
		t.Fatalf("ref_count of the restored blob = %d (%v), want 2", refs, err)
	}

	// Retrying with the same Idempotency-Key does not create revision 5.
	hdr := map[string]string{"Idempotency-Key": "restore-1"}
	a := decode[result](t, ada.raw(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/2:restore", "", nil, hdr))
	b := decode[result](t, ada.raw(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/2:restore", "", nil, hdr))
	if a.rev() != 5 || b.rev() != 5 || a.seq() != b.seq() {
		t.Fatalf("idempotent restore: %v %v", a, b)
	}

	// A deleted file is brought back by restoring one of its revisions, at its last path.
	mustAccepted(t, ada.commit(v, del(f, 5))[0])
	r = decode[result](t, ada.json(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/3:restore", nil))
	if r.status() != "accepted" || r.rev() != 7 {
		t.Fatalf("restore after delete: %v", r)
	}
	tree, _ = ada.tree(v)
	if tree["doc.md"] == nil || tree["doc.md"]["hash"] != hashes[2] {
		t.Fatalf("tree: %v", tree)
	}
	// The deletion record itself has no content to restore.
	r = decode[result](t, ada.json(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/6:restore", nil))
	if r.status() != "rejected" {
		t.Fatalf("restoring a deletion: %v", r)
	}
	expect(t, ada.json(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/99:restore", nil), http.StatusOK)
	expect(t, bob.json(http.MethodPost, "/vaults/"+v+"/files/"+f+"/revisions/1:restore", nil), http.StatusNotFound)
	_ = fmt.Sprint()
}
