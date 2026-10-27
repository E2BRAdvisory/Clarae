//go:build integration

package integration

import (
	"net/http"
	"testing"
)

// After a point-in-time restore the server's sequence numbers go backwards. A
// client whose cursor is ahead must be told to bootstrap: an empty page would
// make it skip every new commit that reuses a sequence number it already saw.
func TestChangesCursorAheadOfServerForcesBootstrap(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Rewound", "shared")
	h := ada.putBlob(v, []byte("x"))
	mustAccepted(t, ada.commit(v, create(newID(), "a.md", h), create(newID(), "b.md", h))[0])
	_, last, _ := ada.changes(v, 0)
	if last != 2 {
		t.Fatalf("last seq = %d", last)
	}

	if items, next, _ := ada.changes(v, last); len(items) != 0 || next != last {
		t.Fatal("a cursor at the head must return an empty page")
	}
	resp := ada.json(http.MethodGet, "/vaults/"+v+"/changes?since=5", nil)
	expect(t, resp, http.StatusGone)
	if pr := decode[map[string]any](t, resp); pr["code"] != "CURSOR_EXPIRED" {
		t.Fatalf("problem: %v", pr)
	}
}
