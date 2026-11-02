//go:build integration

package integration

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
)

// changesPage is one GET changes answer, or the problem of a refusal.
type changesPage struct {
	status  int
	items   []map[string]any
	next    int64
	nextID  string
	more    bool
	problem map[string]any
}

// changesAt reads the changelog after the cursor (since, sinceID), optionally
// through a share and with a page limit.
func (c *client) changesAt(vault, share string, since int64, sinceID string, limit ...int) changesPage {
	c.e.t.Helper()
	q := url.Values{"since": {fmt.Sprint(since)}}
	if len(limit) > 0 {
		q.Set("limit", fmt.Sprint(limit[0]))
	}
	if sinceID != "" {
		q.Set("since_id", sinceID)
	}
	if share != "" {
		q.Set("scope", "share:"+share)
	}
	resp := c.json(http.MethodGet, "/vaults/"+vault+"/changes?"+q.Encode(), nil)
	if resp.StatusCode != http.StatusOK {
		return changesPage{status: resp.StatusCode, problem: decode[map[string]any](c.e.t, resp)}
	}
	out := decode[struct {
		Items   []map[string]any `json:"items"`
		NextSeq float64          `json:"next_seq"`
		NextID  string           `json:"next_id"`
		HasMore bool             `json:"has_more"`
	}](c.e.t, resp)
	return changesPage{status: http.StatusOK, items: out.Items, next: int64(out.NextSeq), nextID: out.NextID, more: out.HasMore}
}

// treeHead is the position GET tree reports.
func (c *client) treeHead(vault, share string) (asOf int64, asOfID string) {
	c.e.t.Helper()
	path := "/vaults/" + vault + "/tree"
	if share != "" {
		path += "?scope=share:" + share
	}
	resp := c.json(http.MethodGet, path, nil)
	expect(c.e.t, resp, http.StatusOK)
	out := decode[struct {
		AsOfSeq float64 `json:"as_of_seq"`
		AsOfID  string  `json:"as_of_id"`
	}](c.e.t, resp)
	return int64(out.AsOfSeq), out.AsOfID
}

// revisionIDAt is the id of the changelog entry at seq, read from the database.
func (e *env) revisionIDAt(vault string, seq int64) string {
	e.t.Helper()
	var id string
	if err := e.db.Pool.QueryRow(ctxBg(), `SELECT id::text FROM file_revisions WHERE vault_id = $1 AND seq = $2`, vault, seq).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

// rewind simulates a point-in-time restore of the vault to seq: the files
// created after it disappear with their revisions and last_seq goes back.
func (e *env) rewind(vault string, seq int64, fileIDs ...string) {
	e.t.Helper()
	for _, f := range fileIDs {
		e.exec(`DELETE FROM files WHERE id = $1`, f)
	}
	e.exec(`UPDATE vaults SET last_seq = $2 WHERE id = $1`, vault, seq)
}

func expectExpired(t *testing.T, p changesPage, member string) {
	t.Helper()
	if p.status != http.StatusGone || p.problem["code"] != "CURSOR_EXPIRED" {
		t.Fatalf("want 410 CURSOR_EXPIRED, got %d %v", p.status, p.problem)
	}
	if extra, _ := p.problem["extra"].(map[string]any); extra[member] == nil {
		t.Fatalf("problem without %s: %v", member, p.problem)
	}
}

// The identity of the cursor travels with it: pages report the id of their
// last change, the manifest the id of the change at its position, and a
// cursor sent back with its id continues normally (ADR-0046).
func TestChangesCursorIdentityPaging(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Identity", "shared")
	h := ada.putBlob(v, []byte("x"))
	for i := 0; i < 5; i++ {
		mustAccepted(t, ada.commit(v, create(newID(), fmt.Sprintf("n%d.md", i), h))[0])
	}

	// An empty vault position has no id; since_id is ignored with since 0.
	first := ada.changesAt(v, "", 0, newID())
	if first.status != http.StatusOK || len(first.items) != 5 {
		t.Fatalf("from 0: %+v", first)
	}

	var cursor int64
	var cursorID string
	for pages := 0; ; pages++ {
		p := ada.changesAt(v, "", cursor, cursorID, 2)
		if p.status != http.StatusOK {
			t.Fatalf("page %d: %+v", pages, p)
		}
		if want := e.revisionIDAt(v, p.next); p.nextID != want {
			t.Fatalf("page %d: next_id %q, want the id at seq %d (%s)", pages, p.nextID, p.next, want)
		}
		cursor, cursorID = p.next, p.nextID
		if !p.more {
			break
		}
	}
	if cursor != 5 {
		t.Fatalf("paging stopped at %d", cursor)
	}

	asOf, asOfID := ada.treeHead(v, "")
	if asOf != 5 || asOfID != e.revisionIDAt(v, 5) {
		t.Fatalf("tree head %d %q", asOf, asOfID)
	}
	// At the head: an empty page that echoes the identity of the cursor.
	if p := ada.changesAt(v, "", asOf, asOfID); p.status != http.StatusOK || len(p.items) != 0 || p.next != asOf || p.nextID != asOfID {
		t.Fatalf("at the head: %+v", p)
	}
	// Without since_id (clients before ADR-0046) the cursor is not verified.
	if p := ada.changesAt(v, "", 3, ""); p.status != http.StatusOK || len(p.items) != 2 || p.nextID != asOfID {
		t.Fatalf("legacy cursor: %+v", p)
	}
}

// After a point-in-time restore and a republish by another device, the
// server's last_seq has grown past a cursor again: only its identity shows
// that the changes up to it are not the ones the client applied.
func TestChangesCursorAtReusedSeqForcesReconcile(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Reused", "shared")
	h := ada.putBlob(v, []byte("x"))
	a, b := newID(), newID()
	mustAccepted(t, ada.commit(v, create(a, "a.md", h))[0])
	mustAccepted(t, ada.commit(v, create(b, "b.md", h))[0])
	before := ada.changesAt(v, "", 0, "")
	if before.next != 2 || before.nextID == "" {
		t.Fatalf("before the restore: %+v", before)
	}

	// Restored to seq 1; another device republishes, reusing seq 2.
	e.rewind(v, 1, b)
	mustAccepted(t, ada.commit(v, create(newID(), "c.md", h))[0])
	mustAccepted(t, ada.commit(v, create(newID(), "d.md", h))[0])

	expectExpired(t, ada.changesAt(v, "", before.next, before.nextID), "last_seq")
	// The legacy cursor cannot tell: it skips seq 2 silently, as before.
	if p := ada.changesAt(v, "", before.next, ""); p.status != http.StatusOK || len(p.items) != 1 {
		t.Fatalf("legacy cursor at a reused seq: %+v", p)
	}
	// A cursor of the current timeline continues.
	cur := ada.changesAt(v, "", 1, e.revisionIDAt(v, 1))
	if cur.status != http.StatusOK || len(cur.items) != 2 || cur.nextID != e.revisionIDAt(v, 3) {
		t.Fatalf("current timeline: %+v", cur)
	}
}

// A change pruned by retention leaves a seq without an entry: the cursor at
// it cannot be verified, and the answer is the bootstrap of an expired cursor
// (compaction_seq), not a reconcile that would republish deleted files.
func TestChangesCursorAtPrunedChangeExpires(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Pruned", "shared")
	h1, h2 := ada.putBlob(v, []byte("one")), ada.putBlob(v, []byte("two"))
	f := newID()
	mustAccepted(t, ada.commit(v, create(f, "a.md", h1))[0])
	mustAccepted(t, ada.commit(v, modify(f, 1, h2))[0])
	mustAccepted(t, ada.commit(v, modify(f, 2, h1))[0])
	cursor := ada.changesAt(v, "", 1, "")
	if cursor.next != 3 {
		t.Fatalf("cursor: %+v", cursor)
	}
	id2 := e.revisionIDAt(v, 2)
	e.exec(`DELETE FROM file_revisions WHERE vault_id = $1 AND seq = 2`, v)

	expectExpired(t, ada.changesAt(v, "", 2, id2), "compaction_seq")
	if p := ada.changesAt(v, "", 2, ""); p.status != http.StatusOK || len(p.items) != 1 || p.nextID != cursor.nextID {
		t.Fatalf("legacy cursor at a pruned change: %+v", p)
	}
}

// Through a share the cursor is still a position in the vault's changelog:
// it may stop on a change the share does not show, whose id is reported all
// the same, and a reused seq is detected there too.
func TestScopedChangesCursorIdentity(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("Scoped identity", "shared")
	h := ada.putBlob(v, []byte("x"))
	mustAccepted(t, ada.commit(v, create(newID(), "Shared/a.md", h))[0])
	outside := newID()
	mustAccepted(t, ada.commit(v, create(outside, "Private/b.md", h))[0])
	sh := ada.share(v, "folder", "Shared", grantTo("user", bob.userID, "viewer"))
	bob.accept(sh.id())

	p := bob.changesAt(v, sh.id(), 0, "")
	if p.status != http.StatusOK || len(p.items) != 1 || p.next != 2 || p.nextID != e.revisionIDAt(v, 2) {
		t.Fatalf("through the share: %+v", p)
	}
	asOf, asOfID := bob.treeHead(v, sh.id())
	if asOf != 2 || asOfID != p.nextID {
		t.Fatalf("scoped tree head %d %q", asOf, asOfID)
	}
	if again := bob.changesAt(v, sh.id(), p.next, p.nextID); again.status != http.StatusOK || len(again.items) != 0 || again.nextID != p.nextID {
		t.Fatalf("at the head through the share: %+v", again)
	}
	// Paged: a full page stops on its last visible change, the next one jumps
	// over the invisible tail to last_seq, each with the id at its position.
	first := bob.changesAt(v, sh.id(), 0, "", 1)
	if first.status != http.StatusOK || len(first.items) != 1 || first.next != 1 || !first.more || first.nextID != e.revisionIDAt(v, 1) {
		t.Fatalf("first scoped page: %+v", first)
	}
	if tail := bob.changesAt(v, sh.id(), first.next, first.nextID, 1); tail.status != http.StatusOK || len(tail.items) != 0 || tail.next != 2 || tail.more || tail.nextID != p.nextID {
		t.Fatalf("scoped tail: %+v", tail)
	}

	// The owner's vault is restored to seq 1 and seq 2 is reused outside the share.
	e.rewind(v, 1, outside)
	mustAccepted(t, ada.commit(v, create(newID(), "Private/c.md", h))[0])
	expectExpired(t, bob.changesAt(v, sh.id(), p.next, p.nextID), "last_seq")
}
