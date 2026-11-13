package sync

// Unit tests of the identity of the changelog cursor (ADR-0046): the id of
// the change at the cursor is kept with it, sent back with every GET changes,
// and a server that handed the seq out again to another change (restored
// backup, then a republish) is answered with the reconcile bootstrap.

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"testing"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/syncproto"
)

// identityRemote is a scripted server whose changelog entries have ids, like
// the cloud: it reports them with its positions and refuses a cursor whose id
// is not the one at its seq, with the 410 of a server that is behind.
type identityRemote struct {
	*scriptRemote
	ids  map[int64]string // id of the change at each seq
	sent []string         // "since:since_id" of every GET changes
}

func newIdentityRemote() *identityRemote {
	return &identityRemote{scriptRemote: newScriptRemote(), ids: map[int64]string{}}
}

func (r *identityRemote) Tree(ctx context.Context) (transport.Tree, error) {
	t, err := r.scriptRemote.Tree(ctx)
	r.mu.Lock()
	t.AsOfID = r.ids[t.AsOfSeq]
	r.mu.Unlock()
	return t, err
}

func (r *identityRemote) Changes(ctx context.Context, since int64, sinceID string, limit int) (transport.Changes, error) {
	r.mu.Lock()
	r.sent = append(r.sent, fmt.Sprintf("%d:%s", since, sinceID))
	at, last := r.ids[since], r.tree.AsOfSeq
	r.mu.Unlock()
	if sinceID != "" && sinceID != at {
		return transport.Changes{}, &transport.ProblemError{StatusCode: http.StatusGone, Problem: syncproto.Problem{
			Status: http.StatusGone, Code: syncproto.CodeCursorExpired, Extra: map[string]any{"last_seq": float64(last)},
		}}
	}
	ch, err := r.scriptRemote.Changes(ctx, since, sinceID, limit)
	r.mu.Lock()
	ch.NextID = r.ids[ch.NextSeq]
	r.mu.Unlock()
	return ch, err
}

func (r *identityRemote) lastSent() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.sent) == 0 {
		return ""
	}
	return r.sent[len(r.sent)-1]
}

func cursorOf(t *testing.T, e *Engine) string {
	t.Helper()
	seq, err := e.cfg.DB.Cursor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	id, err := e.cfg.DB.CursorID(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("%d:%s", seq, id)
}

// The bootstrap keeps the id of the manifest's position, every applied page
// the id of its last change, and both travel back with the cursor; after a
// restore of the server, a cursor at a seq now held by another change leads
// to the reconcile bootstrap, which republishes what the server lost.
func TestCursorIdentityIsKeptAndChecked(t *testing.T) {
	ctx := context.Background()
	remote := newIdentityRemote()
	e, dir := newTestEngine(t, remote, 0)
	remote.tree = transport.Tree{AsOfSeq: 10}
	remote.ids[10] = "id-10"
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := cursorOf(t, e); got != "10:id-10" {
		t.Fatalf("cursor after the bootstrap: %s", got)
	}
	if got := remote.lastSent(); got != "10:id-10" {
		t.Fatalf("GET changes sent %s", got)
	}

	content := []byte("# n, created elsewhere")
	h := remote.put("f-n", 1, content)
	remote.mu.Lock()
	remote.changes = append(remote.changes, transport.Change{Seq: 11, FileID: "f-n", Op: "create", Path: "n.md", Rev: 1, BlobHash: h, Size: int64(len(content))})
	remote.ids[11] = "id-11"
	remote.mu.Unlock()
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "n.md"); got != string(content) {
		t.Fatalf("n.md = %q", got)
	}
	if got := cursorOf(t, e); got != "11:id-11" {
		t.Fatalf("cursor after a page: %s", got)
	}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := remote.lastSent(); got != "11:id-11" {
		t.Fatalf("GET changes sent %s", got)
	}

	// The server is restored to seq 10 and another device republishes: seq 11
	// is another change now and the server's last_seq (12) is past the cursor.
	other := []byte("# o, republished by another device")
	ho := remote.put("f-o", 1, other)
	remote.mu.Lock()
	delete(remote.cur, "f-n")
	delete(remote.curHash, "f-n")
	remote.changes = []transport.Change{
		{Seq: 11, FileID: "f-o", Op: "create", Path: "o.md", Rev: 1, BlobHash: ho, Size: int64(len(other))},
	}
	remote.tree = transport.Tree{AsOfSeq: 12, Items: []transport.TreeEntry{{Path: "o.md", FileID: "f-o", Rev: 1, Hash: ho, Size: int64(len(other))}}}
	remote.ids[11], remote.ids[12] = "id-11-reused", "id-12"
	remote.mu.Unlock()
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "n.md"); got != string(content) {
		t.Fatalf("n.md = %q: the reconcile must keep what the server lost", got)
	}
	if got := readFile(t, dir, "o.md"); got != string(other) {
		t.Fatalf("o.md = %q", got)
	}
	if creates := remote.committed(syncproto.OpCreate, "f-n"); len(creates) != 1 || creates[0].Path != "n.md" {
		t.Fatalf("n.md was not republished: %+v", creates)
	}
	if got := cursorOf(t, e); got != "12:id-12" {
		t.Fatalf("cursor after the reconcile: %s", got)
	}
}

// A cursor saved before ADR-0046 has no id: it is sent without one, and the
// id the server reports for the same position is adopted, so that the next
// requests are verified.
func TestCursorWithoutIDAdoptsTheServers(t *testing.T) {
	ctx := context.Background()
	remote := newIdentityRemote()
	e, _ := newTestEngine(t, remote, 0)
	if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1"); err != nil {
		t.Fatal(err)
	}
	if err := e.cfg.DB.SetCursor(ctx, 7, "", true); err != nil {
		t.Fatal(err)
	}
	remote.tree = transport.Tree{AsOfSeq: 7}
	remote.ids[7] = "id-7"
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(remote.sent, "7:") {
		t.Fatalf("the legacy cursor was not sent as is: %v", remote.sent)
	}
	if got := cursorOf(t, e); got != "7:id-7" {
		t.Fatalf("cursor: %s", got)
	}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := remote.lastSent(); got != "7:id-7" {
		t.Fatalf("GET changes sent %s", got)
	}
}

// SetCursor moves forward only; at the same position it fills in an unknown
// id and never replaces a known one.
func TestSetCursorKeepsTheID(t *testing.T) {
	ctx := context.Background()
	e, _ := newTestEngine(t, newScriptRemote(), 0)
	db := e.cfg.DB
	steps := []struct {
		seq   int64
		id    string
		force bool
		want  string
	}{
		{5, "a", false, "5:a"},
		{4, "b", false, "5:a"}, // backwards
		{5, "c", false, "5:a"}, // same position, id known
		{6, "", false, "6:"},   // forward without an id
		{6, "d", false, "6:d"}, // same position fills the id in
		{3, "e", true, "3:e"},  // bootstrap
		{0, "", true, "0:"},    // reset
	}
	for i, s := range steps {
		if err := db.SetCursor(ctx, s.seq, s.id, s.force); err != nil {
			t.Fatal(err)
		}
		if got := cursorOf(t, e); got != s.want {
			t.Fatalf("step %d: cursor %s, want %s", i, got, s.want)
		}
	}
}
